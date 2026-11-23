import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, Events, GatewayIntentBits, MessageFlags, MessageType, SlashCommandBuilder } from 'discord.js';
import { readDiscordConfig, discordScopeAllowed, discordMessageAddressed, discordEnvPath } from '../lib/discord-config.mjs';
import { createDiscordHandler, discordAttachment } from '../lib/discord-bot.mjs';
import { createDiscordTrace, discordTraceDirectory } from '../lib/discord-trace.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
for (const file of [process.env.SYSTEM0_ENV_FILE || path.join(root, '.env'), discordEnvPath()]) {
  if (existsSync(file)) loadEnvFile(file);
}
const trace = createDiscordTrace({ directory: discordTraceDirectory(),
  secrets: [process.env.DISCORD_BOT_TOKEN, process.env.DISCORD_API_SECRET, process.env.DISCORD_NAVER_FILE_PASSWORD],
  onError: () => console.warn('system0 디스코드 추적 로그를 기록하지 못했습니다.') });
let config;
try { config = readDiscordConfig(process.env, { worker: true }); }
catch (error) {
  trace({ stage: 'gateway.config_failed', ...errorDetails(error) });
  throw new Error('system0 디스코드 봇 설정을 확인해 주세요.');
}
const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
if (config.plainMessageChannelIds.length) intents.push(GatewayIntentBits.MessageContent);
const client = new Client({ intents });
const handle = createDiscordHandler({ config, trace });
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
const configuredChannel = actor => actor.guildId === config.guildId && config.channelIds.includes(actor.channelId);
const requestTrace = (requestId, actor, kind) => (stage, fields = {}) => trace({ stage, requestId, ...actor, kind, ...fields });
const actions = { '송장': 'create_invoice', '등록확인': 'check_registration', '송장파일': 'download_file', '송장상태': 'show_status' };

function errorDetails(error) {
  const code = error?.code;
  const network = /^(?:ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|SOCKET))$/;
  const type = typeof error?.name === 'string' && /^(DiscordAPIError|DiscordjsError|HTTPError|TimeoutError|AbortError|TypeError|RangeError|Error)(?:\[\d{3,6}\])?$/.exec(error.name)?.[1];
  return { ...(type ? { errorType: type } : {}),
    ...(Number.isInteger(code) && code >= 100 && code <= 999999 || typeof code === 'string' && (network.test(code) || /^\d{3,6}$/.test(code)) ? { errorCode: code } : {}),
    ...(Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? { status: error.status } : {}) };
}

async function deliver(record, stage, send, fields = {}) {
  const started = performance.now();
  try {
    const result = await send();
    record(stage, { ...fields, outcome: 'sent', elapsedMs: Math.round(performance.now() - started),
      ...(typeof result?.id === 'string' ? { botMessageId: result.id } : {}) });
    return result;
  } catch (error) {
    record(stage, { ...fields, outcome: 'failed', elapsedMs: Math.round(performance.now() - started), ...errorDetails(error) });
    throw error;
  }
}

client.once(Events.ClientReady, async ready => {
  trace({ stage: 'gateway.ready', guildId: config.guildId });
  try {
    const guild = await ready.guilds.fetch(config.guildId);
    await guild.commands.set(commands.map(command => command.toJSON()));
    trace({ stage: 'gateway.commands_registered', guildId: config.guildId, commandCount: commands.length });
    console.log('system0 디스코드 봇 연결 완료. 지정된 서버·채널·직원만 사용합니다.');
    if (config.plainMessageChannelIds.length) console.log('system0 디스코드 업무 채널 일반 메시지 처리 활성화.');
  } catch (error) {
    trace({ stage: 'gateway.command_registration_failed', guildId: config.guildId, ...errorDetails(error) });
    console.error('디스코드 명령을 등록하지 못했습니다. 서버 초대와 봇 권한을 확인해 주세요.');
    client.destroy(); process.exitCode = 1;
  }
});
client.on(Events.MessageCreate, async message => {
  const actor = scope(message);
  if (message.author.bot || !configuredChannel(actor)) return;
  if (!discordScopeAllowed(config, actor)) {
    trace({ stage: 'gateway.skipped', requestId: message.id, guildId: actor.guildId, channelId: actor.channelId,
      kind: 'message', reason: 'scope_not_allowed' });
    return;
  }
  const record = requestTrace(message.id, actor, 'message');
  let pending;
  try {
    const tagged = message.mentions.users.has(client.user.id);
    const ref = message.type === MessageType.Reply && message.reference;
    const replyToId = ref && ref.channelId === message.channelId && (!ref.guildId || ref.guildId === message.guildId) ? ref.messageId : null;
    record('gateway.received', { mentioned: tagged, replyToId, hasText: Boolean(message.content?.trim()),
      attachmentCount: message.attachments.size, plainChannel: config.plainMessageChannelIds.includes(actor.channelId) });
    let replyToBot = false;
    if (replyToId && !tagged) {
      const replyAuthor = message.mentions.repliedUser || (await message.fetchReference().catch(error => {
        record('gateway.reply_lookup_failed', errorDetails(error));
        return null;
      }))?.author;
      replyToBot = replyAuthor?.id === client.user.id;
      if (!replyToBot) {
        record('gateway.skipped', { reason: replyAuthor ? 'reply_to_other_user' : 'reply_author_unavailable' });
        return;
      }
    }
    if (!discordMessageAddressed(config, { ...actor, mentioned: tagged, replyToBot })) {
      record('gateway.skipped', { reason: 'bot_not_addressed' });
      return;
    }
    if (replyToId && !message.content) {
      record('gateway.skipped', { reason: 'reply_text_unavailable' });
      await deliver(record, 'discord.delivery', () => message.reply({ content: '답장 본문을 읽으려면 같은 메시지에 @system0을 멘션해 주세요.', allowedMentions }));
      return;
    }
    const text = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    const attachments = [...message.attachments.values()].map(discordAttachment);
    if (!text) {
      record('gateway.skipped', { reason: attachments.length ? 'attachment_without_request' : 'empty_request' });
      if (attachments.length) await deliver(record, 'discord.delivery', () => message.reply({ content: '첨부한 파일로 무엇을 할지 함께 적어 주세요.', allowedMentions }));
      return;
    }
    pending = await deliver(record, 'discord.ack', () => message.reply({ content: '처리 중…', allowedMentions }));
    let delivered = false;
    const sendResult = result => deliver(record, 'discord.delivery', () => pending.edit({ ...result, allowedMentions }),
      { fileCount: result.files?.length || 0, componentRowCount: result.components?.length || 0 });
    const output = await handle({ id: message.id, kind: 'message', ...actor, botMessageId: pending.id, replyToId, text, attachments },
    { onProgress: content => deliver(record, 'discord.progress', () => pending.edit({ content, allowedMentions })), onResult: async result => {
      await sendResult(result);
      delivered = true;
    } });
    if (output && !delivered) await sendResult(output);
    else if (!output) await deliver(record, 'discord.pending_removed', () => pending.delete(), { reason: 'empty_handler_result' });
  } catch (error) {
    record('gateway.failed', errorDetails(error));
    if (pending) await deliver(record, 'discord.fallback', () => pending.edit({ content: '결과를 전달하지 못했습니다. system0에서 작업 상태를 확인해 주세요.', allowedMentions })).catch(() => {});
  }
});
client.on(Events.InteractionCreate, async interaction => {
  const selectMenu = interaction.isStringSelectMenu(), component = interaction.isButton() || selectMenu;
  if (!interaction.isChatInputCommand() && !component) return;
  if (component && !/^(s0:|s0r:)/.test(interaction.customId)) return;
  const actor = scope(interaction), kind = component ? 'component' : 'command';
  const record = requestTrace(interaction.id, actor, kind);
  try {
    if (!discordScopeAllowed(config, actor)) {
      if (configuredChannel(actor)) trace({ stage: 'gateway.skipped', requestId: interaction.id, guildId: actor.guildId,
        channelId: actor.channelId, kind, reason: 'scope_not_allowed' });
      await interaction.reply({ content: '이 계정 또는 채널에는 system0 사용 권한이 없습니다.', flags: MessageFlags.Ephemeral }); return;
    }
    const action = Object.hasOwn(actions, interaction.commandName) ? actions[interaction.commandName] : undefined;
    record('gateway.received', component ? { componentKind: selectMenu ? 'select_menu' : 'button' } : { action });
    await deliver(record, 'discord.ack', () => interaction.deferReply({ ...(component ? { flags: MessageFlags.Ephemeral } : {}) }));
    const output = await handle({ id: interaction.id, ...actor, kind,
      ...(component ? { buttonId: interaction.customId, values: selectMenu ? interaction.values : undefined } : { action,
        date: interaction.options.getString('처리일') || undefined,
        attachments: ['파일1', '파일2'].map(name => interaction.options.getAttachment(name)).filter(Boolean).map(discordAttachment) }) },
    { onProgress: content => deliver(record, 'discord.progress', () => interaction.editReply({ content, allowedMentions })) });
    await deliver(record, 'discord.delivery', () => interaction.editReply({ ...(output || { content: '이미 처리 중인 요청입니다.' }), allowedMentions }),
      { fileCount: output?.files?.length || 0, componentRowCount: output?.components?.length || 0 });
  } catch (error) {
    if (!discordScopeAllowed(config, actor)) return;
    record('gateway.failed', errorDetails(error));
    if (interaction.deferred) await deliver(record, 'discord.fallback', () => interaction.editReply({ content: '요청을 처리하지 못했습니다. system0에서 작업 상태를 확인해 주세요.', allowedMentions })).catch(() => {});
  }
});
client.on(Events.Error, error => {
  trace({ stage: 'gateway.error', ...errorDetails(error) });
  console.error('디스코드 연결 오류입니다. 연결과 봇 설정을 확인해 주세요.');
});
client.on(Events.ShardError, (error, shardId) => trace({ stage: 'gateway.shard_error', shardId, ...errorDetails(error) }));
client.on(Events.ShardDisconnect, (event, shardId) => trace({ stage: 'gateway.disconnected', shardId, ...errorDetails(event) }));
client.on(Events.ShardResume, (shardId, replayedEvents) => trace({ stage: 'gateway.resumed', shardId, replayedEvents }));
client.on(Events.Invalidated, () => trace({ stage: 'gateway.invalidated' }));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  trace({ stage: 'gateway.stopped', signal });
  client.destroy();
});
trace({ stage: 'gateway.starting', guildId: config.guildId, plainChannelCount: config.plainMessageChannelIds.length });
try { await client.login(config.token); }
catch (error) {
  trace({ stage: 'gateway.login_failed', guildId: config.guildId, ...errorDetails(error) });
  console.error('디스코드 봇에 로그인하지 못했습니다. 비공개 설정의 토큰을 확인해 주세요.');
  client.destroy(); process.exitCode = 1;
}
