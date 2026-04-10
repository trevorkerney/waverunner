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

settings system where changes are all set at once on save button click, instead of on settings exit

add warning when playing entire seasons without episode numbers (they will likely play out of order)


## BIG STUFF NOW

ensure scroll position is saved post tmdb metadata retrieval

ensure release date checkbox on review tmdb metadata screen is behaving properly (i.e. release date checkbox is defualt checked when tmdb has higher precision)

make title rename on movie/show detail page automatically update when changed without needing refresh

weird issue that should be accounted for. spongebob is the example here. I have seasons 1-6, also season 7 but season 7 has no episodes. All metadata obtained. Something is causing it to still need a refresh to update grid years

star wars top level cover (deep nesting - inside star wars is a collection for each trilogy, containing movies and maybe tv) is not getting year range. not even a refresh fixes it

add "add cover" option to collection context menu. should open file selector for selection

movie/show detail page cover should have change cover in context menu

show resolution and file size of each cover in carousel cover selection

button or ability to import media not currently on media drive. this can potentially provide another method of making collections as well

highlight composers. tmdb has them as crew with job "Composer" or "Original Music Composer"

tv shows have directors per episode, not season or show as a whole. tmdb has them in crew with 
