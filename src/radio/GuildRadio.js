const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const prism = require('prism-media');
const {
  AudioPlayerStatus,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  StreamType
} = require('@discordjs/voice');

class GuildRadio {
  constructor({ guildId, playlistStore, logger = console, onDisconnected = null }) {
    this.guildId = guildId;
    this.playlistStore = playlistStore;
    this.logger = logger;
    this.onDisconnected = typeof onDisconnected === 'function' ? onDisconnected : null;

    this.connection = null;
    this.channelId = null;
    this.player = createAudioPlayer();
    this.currentList = [];
    this.currentIndex = -1;
    this.currentTrack = null;
    this.lastPlaybackError = null;
    this.isAdvancing = false;
    this.stopRequested = false;

    this.player.on(AudioPlayerStatus.Idle, () => {
      if (this.stopRequested) {
        this.stopRequested = false;
        return;
      }
      this.playNext().catch((err) => {
        this.logger.error(`[${this.guildId}] Failed to continue playback:`, err);
      });
    });

    this.player.on('error', (err) => {
      this.logger.error(`[${this.guildId}] Player error:`, err);
      this.lastPlaybackError = err?.message ?? 'Unknown player error';
      this.playNext().catch((nextErr) => {
        this.logger.error(`[${this.guildId}] Failed after player error:`, nextErr);
      });
    });
  }

  async join(voiceChannel) {
    this.channelId = voiceChannel.id;
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true
    });
    this.connection = connection;

    connection.subscribe(this.player);
    this.#attachConnectionRecovery(connection);
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    } catch (err) {
      connection.destroy();
      this.connection = null;
      if (err?.code === 'ABORT_ERR') {
        throw new Error('Voice connection timed out. Check bot Connect/Speak permissions and try again.');
      }
      throw err;
    }
  }

  async playOrResume() {
    if (!this.connection) {
      throw new Error('Not connected to a voice channel.');
    }

    if (this.player.state.status === AudioPlayerStatus.Playing) {
      return this.currentTrack;
    }

    if (this.currentTrack && this.player.state.status === AudioPlayerStatus.Paused) {
      this.player.unpause();
      return this.currentTrack;
    }

    return this.playNext();
  }

  async playNext() {
    if (this.isAdvancing) {
      return this.currentTrack;
    }
    this.isAdvancing = true;

    try {
      this.lastPlaybackError = null;
      this.currentList = await this.playlistStore.getTracksForGuild(this.guildId);
      if (!this.currentList.length) {
        this.currentIndex = -1;
        this.currentTrack = null;
        this.player.stop();
        this.lastPlaybackError = 'Library is empty';
        return null;
      }

      for (let attempts = 0; attempts < this.currentList.length; attempts += 1) {
        this.currentIndex = (this.currentIndex + 1) % this.currentList.length;
        const trackPath = this.currentList[this.currentIndex];
        try {
          const resource = this.#createResource(trackPath);
          this.currentTrack = trackPath;
          this.player.play(resource);
          return this.currentTrack;
        } catch (err) {
          this.lastPlaybackError = err?.message ?? `Failed to load ${path.basename(trackPath)}`;
          this.logger.error(`[${this.guildId}] Failed to load ${trackPath}:`, err);
        }
      }

      this.currentTrack = null;
      return null;
    } finally {
      this.isAdvancing = false;
    }
  }

  async skip() {
    if (!this.currentList.length) {
      this.currentList = await this.playlistStore.getTracksForGuild(this.guildId);
      if (!this.currentList.length) {
        return null;
      }
    }

    this.stopRequested = false;
    this.player.stop(true);
    return this.currentTrack;
  }

  async prev() {
    if (!this.currentList.length) {
      this.currentList = await this.playlistStore.getTracksForGuild(this.guildId);
      if (!this.currentList.length) {
        return null;
      }
    }

    this.lastPlaybackError = null;
    this.currentIndex =
      this.currentIndex <= 0 ? this.currentList.length - 1 : this.currentIndex - 1;
    const trackPath = this.currentList[this.currentIndex];

    try {
      const resource = this.#createResource(trackPath);
      this.currentTrack = trackPath;
      this.stopRequested = true;
      this.player.play(resource);
      return this.currentTrack;
    } catch (err) {
      this.lastPlaybackError = err?.message ?? `Failed to load ${path.basename(trackPath)}`;
      this.logger.error(`[${this.guildId}] Failed to load ${trackPath}:`, err);
      return null;
    }
  }

  stop() {
    this.stopRequested = true;
    this.player.stop(true);
    this.currentTrack = null;
  }

  leave() {
    this.stop();
    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
    }
    this.channelId = null;
    this.#notifyDisconnected();
  }

  pause() {
    if (this.player.state.status !== AudioPlayerStatus.Playing) {
      return false;
    }
    this.player.pause();
    return true;
  }

  resume() {
    if (this.player.state.status !== AudioPlayerStatus.Paused) {
      return false;
    }
    this.player.unpause();
    return true;
  }

  nowPlaying() {
    if (!this.currentTrack) {
      return null;
    }
    return {
      path: this.currentTrack,
      title: path.basename(this.currentTrack)
    };
  }

  getLastPlaybackError() {
    return this.lastPlaybackError;
  }

  #createResource(trackPath) {
    const input = fs.createReadStream(trackPath);
    const ffmpeg = new prism.FFmpeg({
      args: [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
        '-f',
        's16le',
        '-ar',
        '48000',
        '-ac',
        '2'
      ]
    });

    const output = new PassThrough();
    const trackTitle = path.basename(trackPath);
    let failed = false;

    const fail = (context, err) => {
      if (failed) {
        return;
      }
      failed = true;
      const reason = err?.message ?? 'Unknown stream error';
      const wrapped = new Error(`${context} (${trackTitle}): ${reason}`);
      if (!input.destroyed) {
        input.destroy(wrapped);
      }
      ffmpeg.destroy(wrapped);
      output.destroy(wrapped);
    };

    input.once('error', (err) => fail('Input stream failed', err));
    ffmpeg.once('error', (err) => fail('FFmpeg stream failed', err));
    ffmpeg.once('close', (code) => {
      if (code !== 0 && code !== null) {
        fail('FFmpeg exited unexpectedly', new Error(`Exit code ${code}`));
      }
    });

    input.pipe(ffmpeg).pipe(output);

    return createAudioResource(output, {
      inputType: StreamType.Raw,
      metadata: { trackPath }
    });
  }

  #attachConnectionRecovery(connection) {
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
        ]);
      } catch {
        connection.destroy();
        this.connection = null;
        this.channelId = null;
        this.#notifyDisconnected();
      }
    });

    connection.on('error', (err) => {
      this.logger.error(`[${this.guildId}] Voice connection error:`, err);
    });
  }

  #notifyDisconnected() {
    try {
      this.onDisconnected?.(this.guildId);
    } catch (err) {
      this.logger.error(`[${this.guildId}] Disconnection callback failed:`, err);
    }
  }
}

module.exports = { GuildRadio };
