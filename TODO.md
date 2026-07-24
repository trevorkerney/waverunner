# TODO

## test on prod




## bugs / needs fixing

allow user to use waverunner while library is being created, but library being created should remain unavailable until its done being created

editing track metadata in detail view on artist page and saving causes page to jump to top. should update in place. also if start scrolling quickly after updating a tracks metadata, the scroll will jump back up to the top (almost like the page is updating again, idk)

add 'Most loved' to artists page sort options

better scroll position on artists/artist/albums/album pages

when setting a tracks artist, user should be able to pick from list of existing artists. I feel like users should also be able to edit album - at first I though this would be weird since tracks are in album folder, but albums are in artist folder, and we can change tracks artists, so nbd.

consider how main artists vs feature artists works. right now it seems like all songs are only able to have 1 main artist, and to make songs have 2 main artists, you basically have to have an artist that IS both of those artists (or 3 or 4 etc). we need to conclude on a system for this

sometimes playing new songs causes a tiny bit of the song before that to play right before the new song comes on. say for instance i had a song playing, then paused it, then came back a bit later and played another. right as the song to be played queues up you hear a little piece of the song playing before, then the new song comes on.


## changes / small new features

ADHD mode: toggle in settings to allow video and music to be played at the same time

export media covers zip

personal movie/show ratings

switch to skeleton loaders

button somewhere to open source folders, maybe some as well per media

display images (png, jpg, webp, gif, etc) in extras, alongside the video extras (featurettes, webisodes, deleted scenes, etc). Right now the extras scanner only picks up VIDEO files in the reserved extra dirs (collect_extra_files filters is_media_file(VIDEO_EXTENSIONS)); extend it to also collect image files (IMAGE_EXTENSIONS) and store them as extras with a type/kind that distinguishes image vs video. The extras dialog then renders image extras in an image viewer / gallery (lightbox) instead of launching the player, while video extras keep playing as they do now. Use case: promotional stills, behind-the-scenes photos, concept art, posters. (Covers/backgrounds folders are already handled separately as artwork — this is images that live in the extra-content folders, or a dedicated images/stills folder.)


## new features

save cover sets. users should be able to save a set of media covers so that they can easily switch all media covers in a library to the saved set. 

add warnings about tv episodes without episode numbers (they will likely play out of order)

need to consider some sort of ability to queue up things for the player. TV show autoplay should probably take this system into heavy consideration. Users should be able to queue playlists. Users should be able to queue up individual movies in context menus at their whim. On the player and maybe not on the player, the user should be able to view the queue and manipulate it in a dialog or sidebar or something

consider how streamed media should be dealt with as opposed to local media (like from a plex server)

library and usage statistics (prompt user to enable/disable usage stats on first startup)


## minor/later

button or ability to import media not currently on media drive

on the first time someone sets sort mode to custom OR creates a collection, show a very quick tutorial about how to drag media

go through everything ensuring compatibility with MacOS and Linux

settings: sorting language selection (determines which articles like "The", "A", "An" are ignored for alphabetical sort — currently hardcoded to English)


## Embedded Player

CI/build script to auto-download libmpv-2.dll before `tauri build` so release builds always bundle it

Git LFS for libmpv-2.dll as an alternative to the CI approach — keeps the DLL in the repo without bloating git history
