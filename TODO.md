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
    - actors
    - directors/producers
    - custom collections/playlists

settings system where changes are all set at once on save button click, instead of on settings exit

## BIG STUFF NOW

Lets plan it. Shows are going to be the same mostly I think. Episodes need a year, and seasons and shows need a year range. What I'm debating really is which the cast will sit with. Would it be easy from a querying standpoint to, say, get a list of all the cast of a show, assuming the cast is stored with a m2m table 

reduce zoom in out freedom. make it so that, from 100%, the user can go up twice max and down twice min

show resolution and file size of each cover in carousel cover selection

TMDB metadata integration (toggle per library, title resolution: file metadata > folder name > TMDB search)

ability to import media not currently on media drive. however this is done can potentially provide another method of making collections as well
