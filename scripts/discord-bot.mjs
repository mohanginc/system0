import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, Events, GatewayIntentBits, MessageFlags, MessageType, SlashCommandBuilder } from 'discord.js';
import { readDiscordConfig, discordScopeAllowed, discordMessageAddressed, discordEnvPath } from '../lib/discord-config.mjs';
import { createDiscordHandler, discordAttachment } from '../lib/discord-bot.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
for (const file of [process.env.SYSTEM0_ENV_FILE || path.join(root, '.env'), discordEnvPath()]) {
  if (existsSync(file)) loadEnvFile(file);
}
const config = readDiscordConfig(process.env, { worker: true });
const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
if (config.plainMessageChannelIds.length) intents.push(GatewayIntentBits.MessageContent);
const client = new Client({ intents });
const handle = createDiscordHandler({ config });
const allowedMentions = { parse: [], repliedUser: false };
const commands = [
  new SlashCommandBuilder().setName('송장').setDescription('네이버·로젠 파일을 매칭해 네이버 업로드용 엑셀을 만듭니다.')
    .addAttachmentOption(option => option.setName('파일1').setDescription('네이버 주문파일 또는 로젠 송장파일').setRequired(true))
    .addAttachmentOption(option => option.setName('파일2').setDescription('나머지 주문파일 또는 송장파일').setRequired(true))
    .addStringOption(option => option.setName('처리일').setDescription('YYYY-MM-DD, 생략하면 오늘')),
  new SlashCommandBuilder().setName('등록확인').setDescription('관련 오전·오후 송장의 네이버 등록 상태를 조회합니다.')
    .addStringOption(option => option.setName('처리일').setDescription('YYYY-MM-DD, 생략하면 현재 작업 날짜')),
  new SlashCommandBuilder().setName('송장파일').setDescription('이 채널의 최근 송장 작업 파일을 받습니다.'),
  new SlashCommandBuilder().setName('송장상태').setDescription('이 채널의 최근 송장 작업 상태를 확인합니다.'),
];
const scope = event => ({ guildId: event.guildId, channelId: event.channelId, userId: event.user?.id || event.author?.id });

client.once(Events.ClientReady, async ready => {
  try {
    const guild = await ready.guilds.fetch(config.guildId);
    await guild.commands.set(commands.map(command => command.toJSON()));
    console.log('system0 디스코드 봇 연결 완료. 지정된 서버·채널·직원만 사용합니다.');
    if (config.plainMessageChannelIds.length) console.log('system0 디스코드 업무 채널 일반 메시지 처리 활성화.');
  } catch {
    console.error('디스코드 명령을 등록하지 못했습니다. 서버 초대와 봇 권한을 확인해 주세요.');
    client.destroy(); process.exitCode = 1;
  }
});
client.on(Events.MessageCreate, async message => {
  const actor = scope(message);
  if (message.author.bot || !discordScopeAllowed(config, actor)) return;
  let pending;
  try {
    const tagged = message.mentions.users.has(client.user.id);
    const ref = message.type === MessageType.Reply && message.reference;
    const replyToId = ref && ref.channelId === message.channelId && (!ref.guildId || ref.guildId === message.guildId) ? ref.messageId : null;
    let replyToBot = false;
    if (replyToId && !tagged) {
      const replyAuthor = message.mentions.repliedUser || (await message.fetchReference().catch(() => null))?.author;
      replyToBot = replyAuthor?.id === client.user.id;
      if (!replyToBot) return;
    }
    if (!discordMessageAddressed(config, { ...actor, mentioned: tagged, replyToBot })) return;
    if (replyToId && !message.content) {
      await message.reply({ content: '답장 본문을 읽으려면 같은 메시지에 @system0을 멘션해 주세요.', allowedMentions });
      return;
    }
    const text = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    const attachments = [...message.attachments.values()].map(discordAttachment);
    if (!text) {
      if (attachments.length) await message.reply({ content: '첨부한 파일로 무엇을 할지 함께 적어 주세요.', allowedMentions });
      return;
    }
    pending = await message.reply({ content: '처리 중…', allowedMentions });
    let delivered = false;
    const output = await handle({ id: message.id, kind: 'message', ...actor, botMessageId: pending.id, replyToId, text, attachments },
    { onProgress: content => pending.edit({ content, allowedMentions }), onResult: async result => {
      await pending.edit({ ...result, allowedMentions });
      delivered = true;
    } });
    if (output && !delivered) await pending.edit({ ...output, allowedMentions });
    else if (!output) await pending.delete();
  } catch {
    if (pending) await pending.edit({ content: '결과를 전달하지 못했습니다. system0에서 작업 상태를 확인해 주세요.', allowedMentions }).catch(() => {});
  }
});
client.on(Events.InteractionCreate, async interaction => {
  const component = interaction.isButton() || interaction.isStringSelectMenu();
  if (!interaction.isChatInputCommand() && !component) return;
  if (component && !/^(s0:|s0r:)/.test(interaction.customId)) return;
  try {
    if (!discordScopeAllowed(config, scope(interaction))) {
      await interaction.reply({ content: '이 계정 또는 채널에는 system0 사용 권한이 없습니다.', flags: MessageFlags.Ephemeral }); return;
    }
    await interaction.deferReply({ ...(component ? { flags: MessageFlags.Ephemeral } : {}) });
    const actions = { '송장': 'create_invoice', '등록확인': 'check_registration', '송장파일': 'download_file', '송장상태': 'show_status' };
    const output = await handle({ id: interaction.id, ...scope(interaction), kind: component ? 'component' : 'command',
      ...(component ? { buttonId: interaction.customId, values: interaction.isStringSelectMenu() ? interaction.values : undefined } : { action: actions[interaction.commandName],
        date: interaction.options.getString('처리일') || undefined,
        attachments: ['파일1', '파일2'].map(name => interaction.options.getAttachment(name)).filter(Boolean).map(discordAttachment) }) },
    { onProgress: content => interaction.editReply({ content, allowedMentions }) });
    await interaction.editReply({ ...(output || { content: '이미 처리 중인 요청입니다.' }), allowedMentions });
  } catch {
    if (interaction.deferred) await interaction.editReply({ content: '요청을 처리하지 못했습니다. system0에서 작업 상태를 확인해 주세요.', allowedMentions }).catch(() => {});
  }
});
client.on(Events.Error, () => console.error('디스코드 연결 오류입니다. 연결과 봇 설정을 확인해 주세요.'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { client.destroy(); });
try { await client.login(config.token); }
catch { console.error('디스코드 봇에 로그인하지 못했습니다. 비공개 설정의 토큰을 확인해 주세요.'); client.destroy(); process.exitCode = 1; }
