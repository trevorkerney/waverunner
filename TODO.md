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

custom collections / playlists / whatever you want to call it - user should be able to create custom collections

save cover sets. users should be able to save a set of media covers so that they can easily switch all media covers in a library to the saved set. 

save custom sort sets. users should be able to create and name custom sorting sets and easily switch to them (i.e. named sorting sets based on things not in metadata like 'chronological')

sidebar complications (complications like a watch)
  - movies/tv
    - just movies
    - just tv
    - people
      - actors
      - directors/producers
      - composers
    - custom collections/playlists

rotten tomatoes (audience especially) and imdb (maybe metacritic) ratings as well as personal ratings

settings system where changes are all set at once on save button click, instead of on settings exit

add warning when playing entire seasons without episode numbers (they will likely play out of order)


## BIG STUFF NOW

arrow keys break seek bar on player. pressing them seems to bring the player out of sync with the seek bar, meaning it becomes incorrect. Actually looking further, it seems the issue occurs when the user hits left or right arrow keys, WHILE they are hovering the seek bar with their cursor. ACTUALLY, even further, when a user clicks to seek to a certain point, remains hovering the seekbar, and starts hitting left/right arrow, the seekbar slowly moves by the second in the direction provided by the arrow keys - the player does not sync to the new seekbar location UNTIL the user stops hovering the seekbar. Once they stop the hover, the player skips to the seek bar position

weird bugs when changing and viewing media covers, specifically when looking at the hobbit collection media and john wick 3. only pattern i see here is media inside collections, idk tho. basically it is just not displaying covers in the change cover and delete cover menus, which messes up their ui pretty bad. also when this happens the cover doesnt show up in detail view sometimes

adding year to media should add it to movie/show folder name

need some kind of resume where left off functionality

button or ability to import media not currently on media drive. this can potentially provide another method of making collections as well

bind comma and period to prev frame and next frame on player. keybinds menu

highlight composers. tmdb has them as crew with job "Composer" or "Original Music Composer"

tv shows have directors per episode, not season or show as a whole. tmdb has them in crew with 

## Embedded Player

CI/build script to auto-download libmpv-2.dll before `tauri build` so release builds always bundle it

Git LFS for libmpv-2.dll as an alternative to the CI approach — keeps the DLL in the repo without bloating git history
