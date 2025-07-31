// Load environment variables
require('dotenv').config();

// Import required modules
const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer');
const fs = require('fs');

// TOTP opcional (apenas se X_TOTP_SECRET estiver presente)
let authenticator = null;
if (process.env.X_TOTP_SECRET) {
  try {
    authenticator = require('otplib').authenticator;
  } catch {
    console.warn('⚠️ Para TOTP, instale: npm i otplib');
  }
}

// Configuration constants
const TOKEN = process.env.TELEGRAM_TOKEN;
const POLL_MS = process.env.POLL_INTERVAL_MS ? Number(process.env.POLL_INTERVAL_MS) : 30000;
const TREND_CH = process.env.TRENDING_CHANNEL_ID;
const STATS_FILE = './raid-stats.json';
const GROUP_LINKS_FILE = './group-links.json';

// Scraper limits & behavior
const CONCURRENCY = process.env.SCRAPE_CONCURRENCY ? Number(process.env.SCRAPE_CONCURRENCY) : 2;
const JITTER = process.env.POLL_JITTER_MS ? Number(process.env.POLL_JITTER_MS) : 5000;
const HEADLESS = String(process.env.HEADLESS || 'true').toLowerCase() !== 'false';
const USER_DATA_DIR = process.env.USER_DATA_DIR || './.chromium-data';

// ======= Concorrência do scraper (semáforo simples) =======
let inFlight = 0;
const queue = [];
async function withSlot(fn) {
  if (inFlight >= CONCURRENCY) {
    await new Promise(res => queue.push(res));
  }
  inFlight++;
  try { return await fn(); }
  finally {
    inFlight--;
    const next = queue.shift();
    if (next) next();
  }
}

// ======= Parser robusto para contagens (K/M/B e pt-BR “mil/mi”) =======
function parseCount(raw) {
  if (!raw) return 0;
  let t = String(raw).trim().toLowerCase();

  // Normaliza pt-BR → en
  t = t
    .replace(/\s+/g, ' ')
    .replace(/milhões|milhao|milhão|mi/g, 'm')
    .replace(/mil/g, 'k');

  // Decimal vírgula → ponto
  t = t.replace(/(\d),(\d)/g, '$1.$2');

  // número + sufixo opcional
  const m = t.match(/([\d.]+)\s*([kmb])?/i);
  if (!m) {
    const digits = t.replace(/[^\d]/g, '');
    return digits ? parseInt(digits, 10) : 0;
  }
  let n = parseFloat(m[1]);
  const suf = (m[2] || '').toLowerCase();
  if (suf === 'k') n *= 1e3;
  else if (suf === 'm') n *= 1e6;
  else if (suf === 'b') n *= 1e9;
  return Math.round(n);
}

// Initialize data stores
let stats = {};
let groupLinks = {};

// Load existing data from files
if (fs.existsSync(STATS_FILE)) {
  try { stats = JSON.parse(fs.readFileSync(STATS_FILE)); }
  catch (e) { console.error('Error loading stats:', e); }
}
if (fs.existsSync(GROUP_LINKS_FILE)) {
  try { groupLinks = JSON.parse(fs.readFileSync(GROUP_LINKS_FILE)); }
  catch (e) { console.error('Error loading group links:', e); }
}

// Save helpers
function saveStats() { fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2)); }
function saveGroupLinks() { fs.writeFileSync(GROUP_LINKS_FILE, JSON.stringify(groupLinks, null, 2)); }

// Main bot function
(async () => {
  if (!TOKEN) {
    console.error('⚠️ TELEGRAM_TOKEN missing in .env');
    process.exit(1);
  }

  // ======= Página com UA/locale e bloqueio de mídia =======
  async function newPage(browser) {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.setViewport({ width: 1366, height: 900 });
    await page.setRequestInterception(true);
    page.on('request', req => {
      const type = req.resourceType();
      if (type === 'image' || type === 'media' || type === 'font') req.abort();
      else req.continue();
    });
    return page;
  }

  // ======= Browser & sessão (persistência + auto-login opcional) =======
  let browser;
  async function ensureBrowser() {
    if (browser && browser.isConnected()) return browser;
    try {
      if (browser) { try { await browser.close(); } catch {} }
      const launchOpts = {
        headless: HEADLESS,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        userDataDir: USER_DATA_DIR
      };
      browser = await puppeteer.launch(launchOpts);
      return browser;
    } catch (err) {
      console.error('Failed to launch browser:', err);
      process.exit(1);
    }
  }

  async function isLoginWall(page) {
    return await page.evaluate(() => {
      const t = (sel) => document.querySelector(sel);
      const txt = document.body ? (document.body.innerText || '') : '';
      return Boolean(
        t('[data-testid="login"]') ||
        t('form[action*="login"]') ||
        /log in to x|sign in|entrar no x|faça login/i.test(txt)
      );
    });
  }

  function toMobileUrl(url) {
    try {
      const m = url.match(/status\/(\d+)/);
      if (!m) return url;
      const id = m[1];
      return `https://mobile.twitter.com/i/status/${id}?lang=en`;
    } catch { return url; }
  }

  async function waitForTweetHydration(page, timeout = 20000) {
    await Promise.race([
      page.waitForSelector('article', { timeout }),
      page.waitForSelector('[data-testid="tweetText"]', { timeout }),
      page.waitForSelector('main[role="main"] [role="heading"] time', { timeout })
    ]);
  }

  // ======= Auto-login opcional =======
  async function performLogin() {
    if (!process.env.X_USERNAME || !process.env.X_PASSWORD) {
      console.warn('⚠️ Sem X_USERNAME/X_PASSWORD no .env. Faça login manual com HEADLESS=false.');
      return false;
    }
    const page = await newPage(browser);
    try {
      await page.goto('https://x.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });

      // Passo 1: user/email/phone
      await page.waitForSelector('input[name="text"]', { timeout: 30000 });
      await page.type('input[name="text"]', process.env.X_USERNAME, { delay: 20 });
      await page.keyboard.press('Enter');

      // Passo 1.5: às vezes pede @/email extra de verificação
      try {
        await page.waitForSelector('input[name="text"]', { timeout: 5000 });
        // Verifique se a tela mudou pedindo confirmação (texto na página)
        const needsConfirm = await page.evaluate(() => {
          const txt = document.body.innerText.toLowerCase();
          return /confirm your email|confirm your phone|confirme seu e-mail|confirme seu telefone/.test(txt);
        });
        if (needsConfirm && process.env.X_EMAIL) {
          await page.type('input[name="text"]', process.env.X_EMAIL, { delay: 20 });
          await page.keyboard.press('Enter');
        }
      } catch { /* segue */ }

      // Passo 2: senha
      await page.waitForSelector('input[name="password"]', { timeout: 30000 });
      await page.type('input[name="password"]', process.env.X_PASSWORD, { delay: 20 });
      await page.keyboard.press('Enter');

      // Passo 2FA TOTP (opcional)
      if (process.env.X_TOTP_SECRET && authenticator) {
        try {
          // Aguarda campo de 2FA se aparecer
          await page.waitForSelector('input[name="text"]', { timeout: 8000 });
          const is2fa = await page.evaluate(() => {
            const txt = document.body.innerText.toLowerCase();
            return /two-factor|2fa|authentication code|código de verificação|código de autenticação/.test(txt);
          });
          if (is2fa) {
            const code = authenticator.generate(process.env.X_TOTP_SECRET);
            await page.type('input[name="text"]', code, { delay: 20 });
            await page.keyboard.press('Enter');
          }
        } catch { /* pode não ter 2FA */ }
      }

      // Aguarda home/logado
      try {
        await page.waitForSelector('a[aria-label="Profile"], [data-testid="SideNav_AccountSwitcher_Button"], nav[aria-label="Primary"]', { timeout: 30000 });
      } catch (e) {
        // fallback: checa se não é login wall
        if (await isLoginWall(page)) {
          console.error('❌ Falha no login: ainda em login wall.');
          return false;
        }
      }
      console.log('✅ Login no X concluído/persistente.');
      return true;
    } catch (e) {
      console.error('❌ Erro no fluxo de login:', e.message || e);
      return false;
    } finally {
      try { await page.close(); } catch {}
    }
  }

  let sessionRefreshing = false;
  async function ensureSessionLoggedIn() {
    await ensureBrowser();
    const page = await newPage(browser);
    try {
      await page.goto('https://x.com/home?skip_interstitial=true', { waitUntil: 'domcontentloaded', timeout: 45000 });
      try { await page.waitForNetworkIdle({ idleTime: 750, timeout: 10000 }); } catch {}
      const wall = await isLoginWall(page);
      if (!wall) return true;
      console.warn('🔒 Login wall detectado. Tentando login...');
      const ok = await performLogin();
      return ok;
    } catch (e) {
      console.error('ensureSessionLoggedIn error:', e.message || e);
      return false;
    } finally {
      try { await page.close(); } catch {}
    }
  }

  await ensureBrowser();
  // Garante sessão válida no start (não bloqueia se sem credenciais; user pode ter feito login manual antes)
  await ensureSessionLoggedIn();

  console.log('✅ Bot ready');
  const bot = new TelegramBot(TOKEN, { polling: true });
  const raids = new Map();

  // Set bot commands for auto-complete
  await bot.setMyCommands([
    { command: 'raid', description: 'Start a new raid' },
    { command: 'cancel', description: 'Cancel current raid' },
    { command: 'tutorial', description: 'How to use the bot' },
    { command: 'setgrouplink', description: 'Set group invite link' }
  ]);

  // Constants for messages and media
  const MARKDOWN = { parse_mode: 'HTML', disable_web_page_preview: false };
  const RAID_START_GIF = 'https://i.imgur.com/yHCBSBX.mp4';
  const RAID_COMPLETE_GIF = 'https://i.imgur.com/W2R8TcT.mp4';
  const WELCOME_GIF = 'https://i.imgur.com/fyTOI2F.mp4';
  const TUTORIAL_GIF = 'https://i.imgur.com/fyTOI2F.mp4';

  // Phrases
  const updatePhrases = [
    '⚠️ Holders crave 100× but can\'t even finish a single raid.',
    '💥 You demand hypergrowth yet choke on basic execution.',
    '🚨 They fantasize about 100× gains while metrics stagnate.',
    '⚡ Failed raids detected. Upgrade your resolve, holders.',
    '🔥 Delusions of 100× are useless without completing a raid.'
  ];
  const halfwayPhrases = [
    '⚡ Throughput at 50%. Initiating next-tier protocols.',
    '⚡ Systems at half capacity. Deploying auxiliary processes.',
    '⚡ Performance at midpoint. Engaging advanced modules.'
  ];
  const delayPhrases = [
    '⏳ Temporal constraints exceeded predicted window. Accelerating algorithms.',
    '⏳ Latency detected. Boosting computational threads.',
    '⏳ Processing lag detected. Redirecting resources.'
  ];

  // Tutorial & welcome
  const tutorialMessage = `
<b>📚 Raid Bot Tutorial</b>

<u>Core Commands:</u>
<code>/raid URL likes replies retweets</code>
<code>/cancel</code>
<code>/trending</code>
<code>/tutorial</code>
<code>/setgrouplink</code>

<u>How to use:</u>
1. Set your group link first:
   <code>/setgrouplink https://t.me/yourgroup</code>
2. Start a raid:
   <code>/raid https://x.com/status/12345 100 20 50</code>

<em>⚡️ Join our channel: @SingRaidTrending</em>
  `;
  const welcomeMessage = `
<b>🚀 Raid Bot Activated!</b>

To get featured in trending:

1. Set your group link:
   <code>/setgrouplink https://t.me/yourgroup</code>
2. Start raiding!

<em>📌 Use /tutorial for full guide</em>
<em>🔔 Updates: @SingRaidTrending</em>
  `;

  // UI helpers
  function getColorSquare(current, target) {
    if (current >= target) return '🟩';
    const pct = target === 0 ? 0 : (current / target) * 100;
    return pct <= 33 ? '🟥' : '🟨';
  }
  function buildStatus(cur, tgt) {
    const rows = [
      ['Likes', cur.likes, tgt.likes || 0],
      ['Replies', cur.replies, tgt.replies || 0],
      ['Retweets', cur.retweets, tgt.retweets || 0]
    ];
    const labelWidth = Math.max(...rows.map(r => r[0].length));
    const countStrings = rows.map(r => `${r[1]}/${r[2]}`);
    const countWidth = Math.max(...countStrings.map(s => s.length));
    const pctWidth = 4;
    return rows.map(([label, c, t]) => {
      const labelCol = label.padEnd(labelWidth);
      const countRaw = `${c}/${t}`;
      const countCol = countRaw.padStart(countWidth);
      const pctNum = t === 0 ? 100 : Math.min((c / t) * 100, 100);
      const pctRaw = `${pctNum.toFixed(0)}%`.padStart(pctWidth);
      return `${getColorSquare(c, t)} ${labelCol} | ${countCol} ${pctRaw}`;
    }).join('\n');
  }
  function buildCaption(cur, tgt, phrases, tweetUrl) {
    const phrase = phrases[Math.floor(Math.random() * phrases.length)];
    const status = buildStatus(cur, tgt)
      .split('\n').map(l => `<code>${l}</code>`).join('\n');
    return `<b>${phrase}</b>\n\n${status}\n\n🔗 ${tweetUrl}\n\n<em>⚡️ <a href="https://t.me/SingRaidTrending">Powered by Singularity</a></em>`;
  }
  function formatTwitterUrl(url) {
    const match = url.match(/status\/(\d+)/);
    if (!match) return url;
    const tweetId = match[1];
    return `https://x.com/i/status/${tweetId}`;
  }

  // Commands
  bot.onText(/\/start/, msg => {
    bot.sendMessage(msg.chat.id,
      `<b>⚡ Raid Bot Commands:</b>\n\n` +
      `<code>/raid URL L R T</code> - Start raid\n` +
      `<code>/setgrouplink</code> - Add group link\n` +
      `<code>/trending</code> - Leaderboard\n` +
      `<code>/tutorial</code> - Full guide\n\n` +
      `Example:\n<code>/raid https://x.com/status/12345 100 20 50</code>`,
      { parse_mode: 'HTML', disable_web_page_preview: false }
    );
  });

  bot.onText(/\/tutorial/, msg => {
    bot.sendVideo(msg.chat.id, 'https://i.imgur.com/fyTOI2F.mp4', {
      caption: tutorialMessage,
      parse_mode: 'HTML',
      supports_streaming: true,
      reply_markup: {
        inline_keyboard: [[
          { text: '📢 Trending Channel', url: 'https://t.me/SingRaidTrending' }
        ]]
      }
    });
  });

  bot.onText(/\/setgrouplink(@SingRaidBot)?\s*(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const link = match[2] ? match[2].trim() : '';
    if (!link) {
      return bot.sendMessage(chatId,
        `📌 <b>How to set your group link:</b>\n\n` +
        `1. Go to group settings > Invite Links > Create invite link\n` +
        `2. Copy the generated link (example: https://t.me/yourgroup)\n` +
        `3. Send the command:\n` +
        `<code>/setgrouplink https://t.me/yourgroup</code>\n\n` +
        `This will make your group appear as a clickable link on the leaderboard!`,
        { parse_mode: 'HTML' }
      ).catch(e => console.error('Failed to send instructions:', e));
    }
    if (!link.startsWith('https://t.me/') && !link.startsWith('https://telegram.me/')) {
      return bot.sendMessage(chatId,
        '❌ Invalid Telegram group link format.\n' +
        'Please use: <code>https://t.me/groupname</code>\n\n' +
        'Make sure you:\n' +
        '1. Created a permanent invite link\n' +
        '2. Copied the full URL',
        { parse_mode: 'HTML' }
      ).catch(e => console.error('Failed to send error:', e));
    }
    try {
      groupLinks[chatId] = link;
      saveGroupLinks();
      const groupName = msg.chat.title || 'Your Group';
      await bot.sendMessage(chatId,
        `✅ <b>Group link successfully set!</b>\n\n` +
        `Your group will appear as:\n` +
        `<a href="${link}">${groupName}</a>\n\n` +
        `On the trending leaderboard!`,
        { parse_mode: 'HTML' }
      ).catch(e => console.error('Failed to send success:', e));
    } catch (e) {
      console.error('Error saving group link:', e);
      bot.sendMessage(chatId, '❌ Failed to save group link. Please try again later.', { parse_mode: 'HTML' })
        .catch(er => console.error('Failed to send error:', er));
    }
  });

  bot.on('new_chat_members', async msg => {
    const newMembers = msg.new_chat_members;
    const me = await bot.getMe();
    const wasBotAdded = newMembers.some(member => member.id === me.id);
    if (wasBotAdded) {
      setTimeout(() => {
        bot.sendVideo(msg.chat.id, WELCOME_GIF, {
          caption: welcomeMessage,
          parse_mode: 'HTML',
          supports_streaming: true,
          reply_markup: {
            inline_keyboard: [[
              { text: '📢 Trending', url: 'https://t.me/SingRaidTrending' },
              { text: '📚 Tutorial', callback_data: 'tutorial' }
            ]]
          }
        });
      }, 1500);
    }
  });

  bot.on('callback_query', async query => {
    const chatId = query.message.chat.id;
    if (query.data === 'tutorial') {
      bot.answerCallbackQuery(query.id);
      bot.sendVideo(chatId, TUTORIAL_GIF, {
        caption: tutorialMessage,
        parse_mode: 'HTML',
        supports_streaming: true
      });
    } else if (query.data === 'setlink_instructions') {
      bot.answerCallbackQuery(query.id);
      bot.sendMessage(chatId,
        `📌 <b>How to set group link:</b>\n\n` +
        `1. Create invite link (Group Settings > Invite Links)\n` +
        `2. Use:\n<code>/setgrouplink https://t.me/yourgroup</code>\n\n` +
        `Makes your group name clickable in trending!`,
        { parse_mode: 'HTML' }
      );
    }
  });

  bot.onText(/\/raid(@SingRaidBot)?\s*(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const args = match[2] ? match[2].trim().split(/\s+/) : [];
    if (args.length < 4) {
      return bot.sendMessage(chatId,
        `⚡ <b>How to start a raid:</b>\n\n` +
        `<code>/raid URL likes replies retweets</code>\n\n` +
        `<b>Example:</b>\n` +
        `<code>/raid https://x.com/status/12345 100 20 50</code>\n\n` +
        `Where:\n` +
        `🔹 URL - Tweet link to raid\n` +
        `🔹 likes - Target likes count\n` +
        `🔹 replies - Target replies count\n` +
        `🔹 retweets - Target retweets count`,
        { parse_mode: 'HTML' }
      ).catch(e => console.error('Failed to send raid instructions:', e));
    }

    await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    if (raids.has(chatId)) {
      return bot.sendMessage(chatId, '🚫 Active raid exists. Use /cancel.', { parse_mode: 'HTML' });
    }

    const [url, likeT, replyT, retweetT] = args;
    const formattedUrl = formatTwitterUrl(url);
    const targets = { likes: +likeT, replies: +replyT, retweets: +retweetT };

    raids.set(chatId, {
      tweetUrl: formattedUrl,
      targets,
      startTime: Date.now(),
      statusMessageId: null,
      pollCount: 0,
      halfwayNotified: false,
      delayNotified: false,
      backoffMs: 0,
      lastAttempt: 0
    });

    const initial = { likes: 0, replies: 0, retweets: 0 };
    const caption = buildCaption(initial, targets, updatePhrases, formattedUrl);
    const sent = await bot.sendVideo(chatId, RAID_START_GIF, {
      parse_mode: 'HTML',
      disable_web_page_preview: false,
      supports_streaming: true,
      caption,
      reply_markup: {
        inline_keyboard: [[
          { text: '🏆 View Trending', url: 'https://t.me/SingRaidTrending' }
        ]]
      }
    });
    raids.get(chatId).statusMessageId = sent.message_id;

    if (TREND_CH) {
      const name = msg.chat.title || msg.chat.username || chatId;
      const metrics = `Likes:${targets.likes}, Replies:${targets.replies}, Retweets:${targets.retweets}`;
      const notif = `<b>🚀 Raid Started</b>\nGroup: <b>${name}</b>\nPost: ${formattedUrl}\nTargets: ${metrics}`;
      bot.sendMessage(TREND_CH, notif, { parse_mode: 'HTML', disable_web_page_preview: false });
    }
  });

  bot.onText(/\/cancel/, msg => {
    const chatId = msg.chat.id;
    if (raids.delete(chatId)) {
      bot.sendMessage(chatId, '🛑 Raid canceled.', { parse_mode: 'HTML' });
    } else {
      bot.sendMessage(chatId, '❌ No active raid.', { parse_mode: 'HTML' });
    }
  });

  // Trending leaderboard
  async function postTrending(chatId, pin = false) {
    const now = Date.now();
    const decayWindowMs = 3600000; // 1h
    const summary = Object.entries(stats)
      .map(([id, entries]) => {
        const total = entries.reduce((acc, entry) => {
          let score, time;
          if (typeof entry === 'number') { score = entry; time = now; }
          else { ({ score, time } = entry); }
          const ageMs = now - time;
          const decayFactor = ageMs >= decayWindowMs ? 0.5 ** (ageMs / decayWindowMs) : 1;
          return acc + score * decayFactor;
        }, 0);
        return { id, total };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, 15);

    let leaderboard = `<b>⚡ RAID LEADERBOARD</b>\n\n`;
    for (let i = 0; i < summary.length; i++) {
      const { id, total } = summary[i];
      let groupName;
      try {
        const chat = await bot.getChat(id);
        groupName = chat.title || `Group ${id}`;
        if (groupLinks[id]) groupName = `<a href="${groupLinks[id]}">${groupName}</a>`;
      } catch { groupName = `Group ${id}`; }
      const medal = i === 0 ? '🥇 ' : i === 1 ? '🥈 ' : i === 2 ? '🥉 ' : '';
      leaderboard += `${medal}<b>${groupName}</b> - <code>${total.toFixed(2)} pts</code>\n`;
    }

    const caption = leaderboard + `\n<em>Dominate the leaderboard</em>\n\n⏱ Last updated: ${new Date().toLocaleTimeString()}`;
    const sent = await bot.sendVideo(chatId, 'https://i.imgur.com/ANrXs4Z.mp4', {
      caption, parse_mode: 'HTML', supports_streaming: true,
      reply_markup: { inline_keyboard: [[{ text: '💰 Promote', url: 'https://t.me/SingRaidTrending' }]] }
    });

    if (pin) {
      await bot.unpinAllChatMessages(chatId).catch(() => {});
      await bot.pinChatMessage(chatId, sent.message_id, { disable_notification: true }).catch(() => {});
    }
  }

  // ======= fetchMetrics com retries, fallback mobile e detecção de login =======
  async function fetchMetrics(url) {
    await ensureBrowser();

    const attemptOnce = async (targetUrl) => {
      const page = await newPage(browser);
      try {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        try { await page.waitForNetworkIdle({ idleTime: 750, timeout: 10000 }); } catch {}

        // Login wall?
        if (await isLoginWall(page)) {
          return { err: 'LOGIN_WALL' };
        }

        await waitForTweetHydration(page, 20000);

        // Aguarda botões
        await page.waitForSelector(
          '[data-testid="like"], [data-testid="retweet"], [data-testid="reply"]',
          { timeout: 15000 }
        );

        const raw = await page.evaluate(() => {
          const get = (tid) => {
            const btn = document.querySelector(`[data-testid="${tid}"]`);
            if (!btn) return '';
            return btn.getAttribute('aria-label') || btn.innerText || '';
          };
          return {
            likesRaw: get('like'),
            repliesRaw: get('reply'),
            retweetsRaw: get('retweet')
          };
        });

        const likes = parseCount(raw.likesRaw);
        const replies = parseCount(raw.repliesRaw);
        const retweets = parseCount(raw.retweetsRaw);

        if (likes === 0 && replies === 0 && retweets === 0) {
          return { err: 'ZERO_READ' };
        }

        return { likes, replies, retweets };
      } catch (e) {
        return { err: e && e.name === 'TimeoutError' ? 'TIMEOUT' : (e.message || 'ERROR') };
      } finally {
        try { await page.close(); } catch {}
      }
    };

    // Desktop
    const first = await attemptOnce(url);
    if (!first.err) return first;

    // Mobile fallback
    const second = await attemptOnce(toMobileUrl(url));
    if (!second.err) return second;

    const errType = second.err || first.err || 'ERROR';
    if (process.env.DEBUG_FETCH) {
      console.error('[fetchMetrics] fail types:', first.err, '→', second.err);
    }
    return { likes: 0, replies: 0, retweets: 0, err: errType };
  }

  // ======= Processamento de um raid (com backoff e refresh de sessão) =======
  async function pollOneRaid(chatId, raid) {
    const now = Date.now();
    if (raid.backoffMs && now - raid.lastAttempt < raid.backoffMs) {
      return; // respeita backoff
    }

    raid.pollCount++;
    raid.lastAttempt = now;
    console.log(`[Polling] #${raid.pollCount} for ${raid.tweetUrl} (backoff=${raid.backoffMs}ms)`);

    const res = await withSlot(() => fetchMetrics(raid.tweetUrl));
    if (res.err) {
      if (res.err === 'LOGIN_WALL') {
        // Evita tempestade de tentativas: refresca sessão uma vez por onda
        if (!sessionRefreshing) {
          sessionRefreshing = true;
          ensureSessionLoggedIn()
            .then(ok => { if (!ok) console.warn('⚠️ Falha ao recuperar sessão X.'); })
            .finally(() => { sessionRefreshing = false; });
        }
      }
      const prev = raid.backoffMs || 0;
      const next = Math.min(Math.max(30000, prev ? prev * 2 : 30000), 10 * 60 * 1000); // 30s → ... → 10m
      raid.backoffMs = next;
      console.warn(`[Raid ${chatId}] fetch err=${res.err} → backoff=${raid.backoffMs}ms`);
      return;
    }

    // Sucesso: zera backoff
    raid.backoffMs = 0;

    const { likes: L, replies: R, retweets: T } = res;
    const { likes: LT, replies: RT, retweets: TT } = raid.targets;
    const done = L >= LT && R >= RT && T >= TT;

    if (done) {
      const durationSec = (Date.now() - raid.startTime) / 1000;
      const sumTargets = LT + RT + TT;
      const score = sumTargets / Math.max(durationSec, 1);
      if (!Array.isArray(stats[chatId])) stats[chatId] = [];
      stats[chatId].push({ score, time: Date.now() });
      saveStats();

      const cap = buildCaption(res, raid.targets, ['✔️ Singularity achieved. All parameters at maximum.'], raid.tweetUrl);
      await bot.deleteMessage(chatId, raid.statusMessageId).catch(() => {});
      await bot.sendVideo(chatId, RAID_COMPLETE_GIF, {
        parse_mode: 'HTML',
        supports_streaming: true,
        caption: cap
      });

      if (TREND_CH) await postTrending(TREND_CH, true);
      raids.delete(chatId);
    } else {
      const avg = ((L / (LT || 1)) + (R / (RT || 1)) + (T / (TT || 1))) / 3 * 100;
      let phrases = updatePhrases;
      if (!raid.halfwayNotified && avg >= 50) {
        phrases = halfwayPhrases;
        raid.halfwayNotified = true;
      } else if (!raid.delayNotified && raid.pollCount * POLL_MS > 300000) { // >5min
        phrases = delayPhrases;
        raid.delayNotified = true;
      }

      const cap = buildCaption(res, raid.targets, phrases, raid.tweetUrl);
      await bot.deleteMessage(chatId, raid.statusMessageId).catch(() => {});
      const newVid = await bot.sendVideo(chatId, RAID_START_GIF, {
        parse_mode: 'HTML',
        supports_streaming: true,
        caption: cap,
        reply_markup: { inline_keyboard: [[{ text: '🏆 View Trending', url: 'https://t.me/SingRaidTrending' }]] }
      });
      raid.statusMessageId = newVid.message_id;
    }
  }

  // Lock para evitar sobreposição do loop
  let polling = false;
  async function pollLoop() {
    if (polling) return;
    polling = true;
    try {
      for (const [chatId, raid] of raids.entries()) {
        await pollOneRaid(chatId, raid);
      }
    } finally {
      polling = false;
    }
  }

  // Scheduler com jitter
  const BASE = POLL_MS;
  const nextDelay = () => BASE + Math.floor((Math.random() * 2 - 1) * JITTER);
  async function scheduler() {
    try { await pollLoop(); }
    catch (e) { console.error('scheduler error:', e); }
    finally { setTimeout(scheduler, nextDelay()); }
  }
  scheduler();
})();
