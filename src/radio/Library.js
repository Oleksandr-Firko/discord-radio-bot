const fs = require('node:fs/promises');
const path = require('node:path');

const SUPPORTED_EXTENSIONS = new Set([
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',
  '.m4a',
  '.aac',
  '.opus'
]);

class Library {
  constructor(musicDir) {
    this.musicDir = musicDir;
    this.tracks = [];
  }

  async scan() {
    const files = await this.#walk(this.musicDir);
    this.tracks = files
      .filter((file) => SUPPORTED_EXTENSIONS.has(path.extname(file).toLowerCase()))
      .sort((a, b) => a.localeCompare(b));

    return this.tracks;
  }

  getTracks() {
    return [...this.tracks];
  }

  async #walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const result = [];

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        result.push(...(await this.#walk(fullPath)));
      } else if (entry.isFile()) {
        result.push(fullPath);
      }
    }

    return result;
  }
}

module.exports = { Library, SUPPORTED_EXTENSIONS };
