# TODO

## bugs / needs fixing


## changes / small new features

sometimes media is stored on drives that arent fully active all the time. for instance when you start a movie, the drive will spin up and waverunner sorta freezes for a sec while it starts up (i say sorta because it doesn't fully freeze, buttons just stop working), then it loads and starts playing. I'd like to look into solving that issue and making waverunner fully responsive for the couple seconds the disk is booting up. The user should be able to click pause/play, shrink screen to sidebar, stop playback, etc mid drive startup

I want a little thumbnail showing the frame at the hovered spot when cursor is hovering seek bar

personal movie/show ratings

switch to skeleton loaders

ability to edit subtitle size/styling/etc

add some sort of way to choose default library to display

remember size slider position

button somewhere to open source folders, maybe some as well per media


## new features

watch history, resume where left off button, make play say play from beginning if the user has watch history on a movie/show

save cover sets. users should be able to save a set of media covers so that they can easily switch all media covers in a library to the saved set. 

settings system where changes are all set at once on save button click, instead of on settings exit

add warnings about tv episodes without episode numbers (they will likely play out of order)

need to consider some sort of ability to queue up things for the player. TV show autoplay should probably take this system into heavy consideration. Users should be able to queue playlists. Users should be able to queue up individual movies in context menus at their whim. On the player and maybe not on the player, the user should be able to view the queue and manipulate it in a dialog or sidebar or something

bind comma and period to prev frame and next frame on player. KEYBINDS MENU IN SETTINGS

consider how streamed media should be dealt with as opposed to local media (like from a plex server)


## minor/later

button or ability to import media not currently on media drive

on the first time someone sets sort mode to custom OR creates a collection, show a very quick tutorial about how to drag media

go through everything ensuring compatibility with MacOS and Linux

settings: sorting language selection (determines which articles like "The", "A", "An" are ignored for alphabetical sort — currently hardcoded to English)


## Embedded Player

CI/build script to auto-download libmpv-2.dll before `tauri build` so release builds always bundle it

Git LFS for libmpv-2.dll as an alternative to the CI approach — keeps the DLL in the repo without bloating git history
