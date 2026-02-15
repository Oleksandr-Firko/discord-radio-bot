const { REST, Routes, SlashCommandBuilder } = require('discord.js');
require('dotenv').config();

const commandBuilders = [
  new SlashCommandBuilder().setName('join').setDescription('Join your current voice channel'),
  new SlashCommandBuilder().setName('radio').setDescription('Start or continue local radio playback'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop playback'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip current track'),
  new SlashCommandBuilder().setName('prev').setDescription('Play previous track'),
  new SlashCommandBuilder().setName('panel').setDescription('Post or refresh the player control panel'),
  new SlashCommandBuilder().setName('now').setDescription('Show now playing track'),
  new SlashCommandBuilder().setName('rescan').setDescription('Rescan local music directory')
];

const commands = commandBuilders.map((builder) => builder.toJSON());

async function registerCommands({ token, clientId, guildId }) {
  const rest = new REST({ version: '10' }).setToken(token);

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    return;
  }

  await rest.put(Routes.applicationCommands(clientId), { body: commands });
}

module.exports = { commands, registerCommands };

if (require.main === module) {
  const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;

  if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
    console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in environment.');
    process.exit(1);
  }

  registerCommands({
    token: DISCORD_TOKEN,
    clientId: DISCORD_CLIENT_ID,
    guildId: DISCORD_GUILD_ID
  })
    .then(() => {
      console.log(DISCORD_GUILD_ID ? 'Guild commands registered.' : 'Global commands registered.');
    })
    .catch((err) => {
      console.error('Command registration failed:', err);
      process.exit(1);
    });
}
