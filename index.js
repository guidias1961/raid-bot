// Load environment variables
require('dotenv').config();

// Import required modules
const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer');
const fs = require('fs');

// Configuration constants
const TOKEN = process.env.TELEGRAM_TOKEN;
const POLL_MS = process.env.POLL_INTERVAL_MS ? Number(process.env.POLL_INTERVAL_MS) : 30000;
const TREND_CH = process.env.TRENDING_CHANNEL_ID;
const STATS_FILE = './raid-stats.json';
const GROUP_LINKS_FILE = './group-links.json';

// Initialize data stores
let stats = {};
let groupLinks = {};

// Load existing data from files
if (fs.existsSync(STATS_FILE)) {
  try { 
    stats = JSON.parse(fs.readFileSync(STATS_FILE)); 
  } catch (e) {
    console.error('Error loading stats:', e);
  }
}

if (fs.existsSync(GROUP_LINKS_FILE)) {
  try { 
    groupLinks = JSON.parse(fs.readFileSync(GROUP_LINKS_FILE)); 
  } catch (e) {
    console.error('Error loading group links:', e);
  }
}

// Save stats to file
function saveStats() {
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

// Save group links to file
function saveGroupLinks() {
  fs.writeFileSync(GROUP_LINKS_FILE, JSON.stringify(groupLinks, null, 2));
}

// Main bot function
(async () => {
  // Verify token exists
  if (!TOKEN) {
    console.error('⚠️ TELEGRAM_TOKEN missing in .env');
    process.exit(1);
  }

  // Launch browser for scraping
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
  } catch (err) {
    console.error('Failed to launch browser:', err);
    process.exit(1);
  }

  console.log('✅ Bot ready');
  const bot = new TelegramBot(TOKEN, { polling: true });
  const raids = new Map();

  // Set bot commands for auto-complete
  await bot.setMyCommands([
    { command: 'raid', description: 'Start a new raid' },
    { command: 'cancel', description: 'Cancel current raid' },
    { command: 'trending', description: 'Show leaderboard' },
    { command: 'tutorial', description: 'How to use the bot' },
    { command: 'setgrouplink', description: 'Set group invite link' }
  ]);

  // Constants for messages and media
  const MARKDOWN = { parse_mode: 'HTML', disable_web_page_preview: false };
  const RAID_START_GIF = 'https://i.imgur.com/yHCBSBX.mp4';
  const RAID_COMPLETE_GIF = 'https://i.imgur.com/W2R8TcT.mp4';
  const WELCOME_GIF = 'https://i.imgur.com/fyTOI2F.mp4';
  const TUTORIAL_GIF = 'https://i.imgur.com/fyTOI2F.mp4';

  // Phrases for different raid states
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

  const completionPhrases = [
    '✔️ Singularity achieved. All parameters at maximum.',
    '✔️ System convergence complete. Optimal state reached.',
    '✔️ Convergence successful. Maximum throughput sustained.'
  ];

  // Tutorial message template
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

  // Welcome message template
  const welcomeMessage = `
<b>🚀 Raid Bot Activated!</b>

To get featured in trending:

1. Set your group link:
   <code>/setgrouplink https://t.me/yourgroup</code>
2. Start raiding!

<em>📌 Use /tutorial for full guide</em>
<em>🔔 Updates: @SingRaidTrending</em>
  `;

  // Helper function to get color indicator
  function getColorSquare(current, target) {
    if (current >= target) return '🟩';
    const pct = target === 0 ? 0 : (current / target) * 100;
    return pct <= 33 ? '🟥' : '🟨';
  }

  // Build status message
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
      const pctNum = t === 0 ? 100 : Math.min((c / t)*100, 100);
      const pctRaw = `${pctNum.toFixed(0)}%`.padStart(pctWidth);
      return `${getColorSquare(c,t)} ${labelCol} | ${countCol} ${pctRaw}`;
    }).join('\n');
  }

  // Build caption for raid messages
  function buildCaption(cur, tgt, phrases, tweetUrl) {
    const phrase = phrases[Math.floor(Math.random() * phrases.length)];
    const status = buildStatus(cur, tgt)
      .split('\n')
      .map(l => `<code>${l}</code>`)
      .join('\n');
    return `<b>${phrase}</b>\n\n${status}\n\n🔗 ${tweetUrl}\n\n<em>⚡️ <a href="https://t.me/SingRaidTrending">Powered by Singularity</a></em>`;
  }

  // Format Twitter URL consistently
  function formatTwitterUrl(url) {
    const match = url.match(/status\/(\d+)/);
    if (!match) return url;
    const tweetId = match[1];
    return `https://x.com/i/status/${tweetId}`;
  }

  // Command handlers...

  // Start command
  bot.onText(/\/start/, msg => {
    bot.sendMessage(msg.chat.id,
      `<b>⚡ Raid Bot Commands:</b>\n\n` +
      `<code>/raid URL L R T</code> - Start raid\n` +
      `<code>/setgrouplink</code> - Add group link\n` +
      `<code>/trending</code> - Leaderboard\n` +
      `<code>/tutorial</code> - Full guide\n\n` +
      `Example:\n<code>/raid https://x.com/status/12345 100 20 50</code>`,
      MARKDOWN
    );
  });

  // Tutorial command
  bot.onText(/\/tutorial/, msg => {
    bot.sendVideo(msg.chat.id, TUTORIAL_GIF, {
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

  // Set group link command
  bot.onText(/\/setgrouplink(@SingRaidBot)?\s*(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const link = match[2] ? match[2].trim() : '';

    // If no link provided, show instructions
    if (!link) {
      return bot.sendMessage(chatId, 
        `📌 <b>How to set your group link:</b>\n\n` +
        `1. Go to group settings > Invite Links > Create invite link\n` +
        `2. Copy the generated link (example: https://t.me/yourgroup)\n` +
        `3. Send the command:\n` +
        `<code>/setgrouplink https://t.me/yourgroup</code>\n\n` +
        `This will make your group appear as a clickable link on the leaderboard!`,
        MARKDOWN
      ).catch(e => console.error('Failed to send instructions:', e));
    }
    
    // Validate link format
    if (!link.startsWith('https://t.me/') && !link.startsWith('https://telegram.me/')) {
      return bot.sendMessage(chatId, 
        '❌ Invalid Telegram group link format.\n' +
        'Please use: <code>https://t.me/groupname</code>\n\n' +
        'Make sure you:\n' +
        '1. Created a permanent invite link\n' +
        '2. Copied the full URL',
        MARKDOWN
      ).catch(e => console.error('Failed to send error:', e));
    }

    // Save the link
    try {
      groupLinks[chatId] = link;
      saveGroupLinks();
      
      const groupName = msg.chat.title || 'Your Group';
      await bot.sendMessage(chatId, 
        `✅ <b>Group link successfully set!</b>\n\n` +
        `Your group will appear as:\n` +
        `<a href="${link}">${groupName}</a>\n\n` +
        `On the trending leaderboard!`,
        MARKDOWN
      ).catch(e => console.error('Failed to send success:', e));
      
    } catch (e) {
      console.error('Error saving group link:', e);
      bot.sendMessage(chatId, 
        '❌ Failed to save group link. Please try again later.',
        MARKDOWN
      ).catch(e => console.error('Failed to send error:', e));
    }
  });

  // New chat member handler (for welcome message)
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

  // Callback query handler
  bot.on('callback_query', async query => {
    const chatId = query.message.chat.id;
    
    if (query.data === 'tutorial') {
      bot.answerCallbackQuery(query.id);
      bot.sendVideo(chatId, TUTORIAL_GIF, {
        caption: tutorialMessage,
        parse_mode: 'HTML',
        supports_streaming: true
      });
    }
    else if (query.data === 'setlink_instructions') {
      bot.answerCallbackQuery(query.id);
      bot.sendMessage(chatId, 
        `📌 <b>How to set group link:</b>\n\n` +
        `1. Create invite link (Group Settings > Invite Links)\n` +
        `2. Use:\n<code>/setgrouplink https://t.me/yourgroup</code>\n\n` +
        `Makes your group name clickable in trending!`,
        MARKDOWN
      );
    }
  });

  // Raid command handler
  bot.onText(/\/raid(@SingRaidBot)?\s*(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const args = match[2] ? match[2].trim().split(/\s+/) : [];
    
    // If not enough arguments, show instructions
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
        MARKDOWN
      ).catch(e => console.error('Failed to send raid instructions:', e));
    }

    await bot.deleteMessage(chatId, msg.message_id).catch(() => {});

    if (raids.has(chatId)) {
      return bot.sendMessage(chatId, '🚫 Active raid exists. Use /cancel.', MARKDOWN);
    }
    
    const [url, likeT, replyT, retweetT] = args;
    const formattedUrl = formatTwitterUrl(url);
    const targets = { 
      likes: +likeT, 
      replies: +replyT, 
      retweets: +retweetT 
    };
    
    raids.set(chatId, {
      tweetUrl: formattedUrl,
      targets,
      startTime: Date.now(),
      statusMessageId: null,
      pollCount: 0,
      halfwayNotified: false,
      delayNotified: false
    });

    const initial = { likes: 0, replies: 0, retweets: 0 };
    const caption = buildCaption(initial, targets, updatePhrases, formattedUrl);
    const sent = await bot.sendVideo(chatId, RAID_START_GIF, {
      ...MARKDOWN,
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
      bot.sendMessage(TREND_CH, notif, { 
        parse_mode: 'HTML', 
        disable_web_page_preview: false 
      });
    }
  });

  // Cancel command handler
  bot.onText(/\/cancel/, msg => {
    const chatId = msg.chat.id;
    if (raids.delete(chatId)) {
      bot.sendMessage(chatId, '🛑 Raid canceled.', MARKDOWN);
    } else {
      bot.sendMessage(chatId, '❌ No active raid.', MARKDOWN);
    }
  });

  // Trending command handler
  bot.onText(/\/trending/, async msg => {
    await postTrending(msg.chat.id, true);
  });

  // Post trending leaderboard with decay after 1 hour
  async function postTrending(chatId, pin = false) {
    const now = Date.now();
    const decayWindowMs = 3600000; // 1 hour in milliseconds

    const summary = Object.entries(stats)
      .map(([id, entries]) => {
        const total = entries.reduce((acc, entry) => {
          let score, time;
          // Backward compatibility: if entry is just a number
          if (typeof entry === 'number') {
            score = entry;
            time = now; // don't apply decay
          } else {
            ({ score, time } = entry);
          }

          const ageMs = now - time;
          // Decay factor: 1.0 → 0.5 → 0.25 → ... every 1h
          const decayFactor = ageMs >= decayWindowMs
            ? 0.5 ** (ageMs / decayWindowMs)
            : 1;

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
        if (groupLinks[id]) {
          groupName = `<a href="${groupLinks[id]}">${groupName}</a>`;
        }
      } catch {
        groupName = `Group ${id}`;
      }

      const medal = i === 0 ? '🥇 ' : i === 1 ? '🥈 ' : i === 2 ? '🥉 ' : '';
      leaderboard += `${medal}<b>${groupName}</b> - <code>${total.toFixed(2)} pts</code>\n`;
    }

    const caption = leaderboard + `\n<em>Dominate the leaderboard</em>\n\n⏱ Last updated: ${new Date().toLocaleTimeString()}`;

    const sent = await bot.sendVideo(chatId, 'https://i.imgur.com/ANrXs4Z.mp4', {
      caption: caption,
      parse_mode: 'HTML',
      supports_streaming: true,
      reply_markup: {
        inline_keyboard: [[
          { text: '💰 Promote', url: 'https://t.me/SingRaidTrending' }
        ]]
      }
    });

    if (pin) {
      await bot.unpinAllChatMessages(chatId).catch(() => {});
      await bot.pinChatMessage(chatId, sent.message_id, { disable_notification: true }).catch(() => {});
    }
  }

  // Fetch Twitter metrics
  async function fetchMetrics(url) {
    if (!browser.isConnected()) {
      await browser.close().catch(() => {});
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      });
    }
    
    const page = await browser.newPage();
    try {
      await page.goto(url, { 
        waitUntil: 'domcontentloaded', 
        timeout: 30000 
      });
      await page.waitForSelector('article', { timeout: 10000 });
      
      return await page.evaluate(() => {
        const g = sel => {
          const e = document.querySelector(sel);
          return e ? parseInt(e.innerText.replace(/[^\d]/g, ''), 10) || 0 : 0;
        };
        
        return {
          likes: g('[data-testid="like"]'),
          replies: g('[data-testid="reply"]'),
          retweets: g('[data-testid="retweet"]')
        };
      });
    } catch (e) {
      console.error('Error fetching metrics:', e);
      return { likes: 0, replies: 0, retweets: 0 };
    } finally {
      await page.close().catch(() => {});
    }
  }

  // Polling loop for active raids
  async function pollLoop() {
    for (const [chatId, raid] of raids.entries()) {
      raid.pollCount++;
      console.log(`[Polling] #${raid.pollCount} for ${raid.tweetUrl}`);

      const cur = await fetchMetrics(raid.tweetUrl);
      const { likes: L, replies: R, retweets: T } = cur;
      const { likes: LT, replies: RT, retweets: TT } = raid.targets;
      const done = L >= LT && R >= RT && T >= TT;

      if (done) {
        const durationSec = (Date.now() - raid.startTime) / 1000;
        const sumTargets = LT + RT + TT;
        const score = sumTargets / durationSec;
        
        if (!Array.isArray(stats[chatId])) stats[chatId] = [];
        stats[chatId].push(score);
        saveStats();

        const cap = buildCaption(cur, raid.targets, completionPhrases, raid.tweetUrl);
        await bot.deleteMessage(chatId, raid.statusMessageId).catch(() => {});
        await bot.sendVideo(chatId, RAID_COMPLETE_GIF, {
          ...MARKDOWN,
          supports_streaming: true,
          caption: cap
        });

        if (TREND_CH) await postTrending(TREND_CH, true);
        raids.delete(chatId);
      } else {
        const avg = ((L / (LT||1)) + (R / (RT||1)) + (T / (TT||1))) / 3 * 100;
        let phrases = updatePhrases;
        
        if (!raid.halfwayNotified && avg >= 50) {
          phrases = halfwayPhrases;
          raid.halfwayNotified = true;
        } else if (!raid.delayNotified && raid.pollCount * POLL_MS > 300000) {
          phrases = delayPhrases;
          raid.delayNotified = true;
        }
        
        const cap = buildCaption(cur, raid.targets, phrases, raid.tweetUrl);
        await bot.deleteMessage(chatId, raid.statusMessageId).catch(() => {});
        
        const newVid = await bot.sendVideo(chatId, RAID_START_GIF, {
          ...MARKDOWN,
          supports_streaming: true,
          caption: cap,
          reply_markup: {
            inline_keyboard: [[
              { text: '🏆 View Trending', url: 'https://t.me/SingRaidTrending' }
            ]]
          }
        });
        
        raid.statusMessageId = newVid.message_id;
      }
    }
  }

  // Start polling loop
  setInterval(pollLoop, POLL_MS);
})();