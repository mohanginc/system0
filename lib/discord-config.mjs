import os from 'node:os';
import path from 'node:path';
const snowflake = /^\d{17,20}$/;

export function discordEnvPath(env = process.env) {
  return env.DISCORD_ENV_FILE || (process.platform === 'win32'
    ? path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'system0', 'discord.env')
    : '/etc/system0-discord.env');
}

export function readDiscordConfig(env = process.env, { worker = false } = {}) {
  const fields = ['DISCORD_API_SECRET', 'DISCORD_GUILD_ID', 'DISCORD_CHANNEL_IDS', 'DISCORD_USER_IDS'];
  const missing = fields.filter(key => !env[key]?.trim());
  if (missing.length && !worker) return null;
  if (worker && !env.DISCORD_BOT_TOKEN?.trim()) missing.push('DISCORD_BOT_TOKEN');
  if (missing.length) throw new Error(`디스코드 설정이 필요합니다: ${missing.join(', ')}`);
  const list = key => [...new Set((env[key] || '').split(',').map(value => value.trim()))];
  const guildId = env.DISCORD_GUILD_ID.trim(), channelIds = list('DISCORD_CHANNEL_IDS'), userIds = list('DISCORD_USER_IDS');
  const plainMessageChannelIds = env.DISCORD_PLAIN_MESSAGE_CHANNEL_IDS?.trim() ? list('DISCORD_PLAIN_MESSAGE_CHANNEL_IDS') : [];
  if (!snowflake.test(guildId) || [...channelIds, ...userIds].some(id => !snowflake.test(id))) {
    throw new Error('디스코드 서버·채널·직원 ID는 숫자 ID로 지정해 주세요.');
  }
  if (plainMessageChannelIds.some(id => !channelIds.includes(id))) {
    throw new Error('일반 메시지를 처리할 디스코드 채널은 허용된 채널 안에서 지정해 주세요.');
  }
  const secret = env.DISCORD_API_SECRET.trim();
  if (secret.length < 32 || secret.length > 256) throw new Error('디스코드 내부 연결 키는 32~256자여야 합니다.');
  const base = new URL(env.DISCORD_API_BASE || `http://127.0.0.1:${env.PORT || 3000}`);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname)
    || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('디스코드 봇은 같은 서버의 로컬 system0 주소에 연결해야 합니다.');
  }
  const origin = new URL(env.SYSTEM0_PUBLIC_ORIGIN || base.origin);
  if ((origin.protocol !== 'https:' && origin.origin !== base.origin) || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error('디스코드 작업 링크에 사용할 system0 주소를 확인해 주세요.');
  }
  return { secret, guildId, channelIds, userIds, plainMessageChannelIds, baseUrl: base.origin, publicOrigin: origin.origin,
    token: env.DISCORD_BOT_TOKEN?.trim() || '', naverPassword: env.DISCORD_NAVER_FILE_PASSWORD || '' };
}

export function discordScopeAllowed(config, { guildId, channelId, userId }) {
  return Boolean(config && guildId === config.guildId && config.channelIds.includes(channelId) && config.userIds.includes(userId));
}

export function discordMessageAddressed(config, message) {
  return discordScopeAllowed(config, message)
    && Boolean(message.mentioned || message.replyToBot || config.plainMessageChannelIds?.includes(message.channelId));
}
