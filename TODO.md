# TODO

add hover tooltips to format options explaining them

when there are options between local library and externally managed library, have hover tooltips for that too

implement ratings display by user self-submitted OMDB api key in settings

add some sort of recently watched feature

add some sort of way to choose default library to display

consider how streamed media should be dealt with as opposed to local media (like from a plex server)

settings: sorting language selection (determines which articles like "The", "A", "An" are ignored for alphabetical sort — currently hardcoded to English)

shadcn badges for genres/tags etc

on the first time someone sets sort mode to custom OR creates a collection, show a very quick tutorial about how to drag media

go through everything ensuring compatibility with MacOS and Linux

save cover sets. users should be able to save a set of media covers so that they can easily switch all media covers in a library to the saved set. 

rotten tomatoes (audience especially) and imdb (maybe metacritic) ratings as well as personal ratings

settings system where changes are all set at once on save button click, instead of on settings exit

add warning when playing entire seasons without episode numbers (they will likely play out of order)

POSSIBLY FIXED: weird bugs when changing and viewing media covers, specifically when looking at the hobbit collection media and john wick 3. only pattern i see here is media inside collections, idk tho. basically it is just not displaying covers in the change cover and delete cover menus, which messes up their ui pretty bad. also when this happens the cover doesnt show up in detail view sometimes


## BIG STUFF NOW

going into collections and adding things to playlist makes app forget scroll location on prev menu sometimes MAYBE. Seems to be when I go back by clicking previous breadcrumbs after adding things to playlist

adding year to media should add it to movie/show folder name
- add automatic TMDB matches for movies with title and release year

remember size slider better maybe

need to consider some sort of ability to queue up things for the player. TV show autoplay should probably take this system into heavy consideration. Users should be able to queue playlists. Users should be able to queue up individual movies in context menus at their whim. On the player and maybe not on the player, the user should be able to view the queue and manipulate it in a dialog or sidebar or something

need some kind of resume where left off functionality

button or ability to import media not currently on media drive. this can potentially provide another method of making collections as well

bind comma and period to prev frame and next frame on player. keybinds menu

highlight composers. tmdb has them as crew with job "Composer" or "Original Music Composer"

tv shows have directors per episode, not season or show as a whole. tmdb has them in crew with 

## Embedded Player

CI/build script to auto-download libmpv-2.dll before `tauri build` so release builds always bundle it

Git LFS for libmpv-2.dll as an alternative to the CI approach — keeps the DLL in the repo without bloating git history
