require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer');

const TOKEN = process.env.TELEGRAM_TOKEN;
const POLL_INTERVAL = process.env.POLL_INTERVAL_MS
  ? Number(process.env.POLL_INTERVAL_MS)
  : 30000;

// Substitua pelos links diretos aos arquivos .mp4
const RAID_START_GIF    = 'https://i.imgur.com/yHCBSBX.mp4';
const RAID_PROGRESS_GIF = 'https://i.imgur.com/fyTOI2F.mp4';
const RAID_COMPLETE_GIF = 'https://i.imgur.com/W2R8TcT.mp4';

if (!TOKEN) {
  console.error('⚠️ TELEGRAM_TOKEN missing in .env');
  process.exit(1);
}

(async () => {
  let browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  console.log('✅ Bot ready');
  const bot = new TelegramBot(TOKEN, { polling: true });
  const raids = new Map();
  const MARKDOWN = { parse_mode: 'HTML', disable_web_page_preview: true };

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
  const completionPhrases = [
    '✔️ Singularity achieved. All parameters at maximum.',
    '✔️ System convergence complete. Optimal state reached.',
    '✔️ Convergence successful. Maximum throughput sustained.'
  ];
  const updatePhrases = [
    '⚠️ Holders crave 100× but can’t even finish a single raid.',
    '💥 You demand hypergrowth yet choke on basic execution.',
    '🚨 They fantasize about 100× gains while metrics stagnate.',
    '⚡ Failed raids detected. Upgrade your resolve, holders.',
    '🔥 Delusions of 100× are useless without raid completion.',
    '🔧 Systems online, yet holders offline when push comes to metrics.',
    '⚔️ You signed up for conquest, not spectator mode.',
    '💣 Promises of moonshots collapse under simple raids.',
    '🔒 Locked targets unachieved. Holders, calibrate your focus.',
    '⚡ Activation sequence started—but holders are still idling.'
  ];

  function getColorSquare(current, target) {
    if (current >= target) return '🟩';
    const pct = target === 0 ? 0 : (current / target) * 100;
    return pct <= 33 ? '🟥' : '🟨';
  }

  function buildStatus(cur, tgt) {
    const rows = [
      ['Likes',    cur.likes,    tgt.likes  || 0],
      ['Replies',  cur.replies,  tgt.replies|| 0],
      ['Retweets', cur.retweets, tgt.retweets|| 0],
    ];
    const labelWidth = Math.max(...rows.map(r => r[0].length));
    const countStrings = rows.map(r => `${r[1]}/${r[2]}`);
    const countWidth = Math.max(...countStrings.map(s => s.length));
    const pctWidth = 4; // e.g. "100%"

    let text = '';
    for (const [label, c, t] of rows) {
      const labelCol = label.padEnd(labelWidth);
      const countRaw = `${c}/${t}`;
      const countCol = countRaw.padStart(countWidth);
      const pctNum = t === 0 ? 100 : Math.min((c / t) * 100, 100);
      const pctRaw = `${pctNum.toFixed(0)}%`;
      const pctCol = pctRaw.padStart(pctWidth);
      text += `${getColorSquare(c, t)} ${labelCol} | ${countCol} ${pctCol}\n`;
    }
    return text;
  }

  async function fetchMetrics(url) {
    if (!browser.isConnected()) {
      console.warn('⚠️ Browser disconnected, relaunching...');
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      });
    }
    let page;
    try {
      page = await browser.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('article', { timeout: 10000 });
      const data = await page.evaluate(() => {
        const getCount = sel => {
          const el = document.querySelector(sel);
          return el ? (parseInt(el.innerText.replace(/[^\d]/g, ''), 10) || 0) : 0;
        };
        return {
          likes:    getCount('[data-testid="like"]'),
          replies:  getCount('[data-testid="reply"]'),
          retweets: getCount('[data-testid="retweet"]')
        };
      });
      return data;
    } catch (err) {
      console.error('❌ fetchMetrics error:', err.message);
      return { likes: 0, replies: 0, retweets: 0 };
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  bot.onText(/\/raid\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    try { await bot.deleteMessage(chatId, msg.message_id); } catch {}
    if (raids.has(chatId)) {
      return bot.sendMessage(chatId, '🚫 There is already an active raid here. Use /cancel.');
    }
    const [, url, likeT, replyT, retweetT] = match;
    const targets = { likes:+likeT, replies:+replyT, retweets:+retweetT };
    const initial = { likes:0, replies:0, retweets:0 };
    const phrase = updatePhrases[Math.floor(Math.random()*updatePhrases.length)];

    const status = buildStatus(initial, targets);
    const startCaption = `<b>${phrase}</b>\n<pre>${status}</pre><a href="${url}">🔗 Tweet Link</a>\n<em>⚡️ Powered by Singularity</em>`;

    const sent = await bot.sendVideo(chatId, RAID_START_GIF, {
      ...MARKDOWN,
      supports_streaming: true,
      caption: startCaption
    });

    raids.set(chatId, {
      tweetUrl: url,
      targets,
      statusMessageId: sent.message_id,
      pollCount: 0,
      halfwayNotified: false,
      delayNotified: false
    });
  });

  bot.onText(/\/cancel/, async (msg) => {
    const chatId = msg.chat.id;
    if (!raids.has(chatId)) {
      return bot.sendMessage(chatId, '❌ No active raid to cancel.');
    }
    raids.delete(chatId);
    bot.sendMessage(chatId, '🛑 Raid canceled.');
  });

  async function pollLoop() {
    try {
      for (const [chatId, raid] of raids.entries()) {
        raid.pollCount++;
        const cur = await fetchMetrics(raid.tweetUrl);
        const { likes:L, replies:R, retweets:T } = cur;
        const { likes:LT, replies:RT, retweets:TT } = raid.targets;
        const done = L >= LT && R >= RT && T >= TT;

        if (done) {
          const comp = completionPhrases[Math.floor(Math.random()*completionPhrases.length)];
          const finalStatus = buildStatus(cur, raid.targets);
          const completeCaption = `<b>${comp}</b>\n<pre>${finalStatus}</pre><em>⚡️ Powered by Singularity</em>`;

          try { await bot.deleteMessage(chatId, raid.statusMessageId); } catch {}
          await bot.sendVideo(chatId, RAID_COMPLETE_GIF, {
            ...MARKDOWN,
            supports_streaming: true,
            caption: completeCaption
          });
          raids.delete(chatId);

        } else {
          let updatePhrase = updatePhrases[Math.floor(Math.random()*updatePhrases.length)];
          const avgPct = ((L/ (LT||1)) + (R/(RT||1)) + (T/(TT||1))) / 3 * 100;
          if (!raid.halfwayNotified && avgPct >= 50) {
            updatePhrase = halfwayPhrases[Math.floor(Math.random()*halfwayPhrases.length)];
            raid.halfwayNotified = true;
          }
          if (!raid.delayNotified && raid.pollCount >= 10) {
            updatePhrase = delayPhrases[Math.floor(Math.random()*delayPhrases.length)];
            raid.delayNotified = true;
          }
          const rowsText = buildStatus(cur, raid.targets);
          const progressCaption = `<b>${updatePhrase}</b>\n<pre>${rowsText}</pre><a href="${raid.tweetUrl}">🔗 Tweet Link</a>\n<em>⚡️ Powered by Singularity</em>`;

          try { await bot.deleteMessage(chatId, raid.statusMessageId); } catch {}
          const nm = await bot.sendVideo(chatId, RAID_PROGRESS_GIF, {
            ...MARKDOWN,
            supports_streaming: true,
            caption: progressCaption
          });
          raid.statusMessageId = nm.message_id;
        }
      }
    } catch (e) {
      console.error('❌ pollLoop error:', e.message);
    } finally {
      setTimeout(pollLoop, POLL_INTERVAL);
    }
  }

  pollLoop();
})();