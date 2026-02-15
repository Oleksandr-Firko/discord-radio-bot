class PlaylistStore {
  constructor(library) {
    this.library = library;
  }

  async getTracksForGuild() {
    return this.library.getTracks();
  }
}

module.exports = { PlaylistStore };
