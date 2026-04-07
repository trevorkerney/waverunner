add hover tooltips to format options explaining them

when there are options between local library and externally managed library, have hover tooltips for that too

implement ratings display by user self-submitted OMDB api key in settings

add some sort of recently watched feature

add some sort of way to choose default library to display

per-collection sort mode (alpha / year / custom) with drag-and-drop reorder behind a button

TMDB metadata integration (toggle per library, title resolution: file metadata > folder name > TMDB search)



consider how streamed media should be dealt with as opposed to local media (like from a plex server)

settings: sorting language selection (determines which articles like "The", "A", "An" are ignored for alphabetical sort — currently hardcoded to English)

shadcn badges for genres/tags etc



# BIG STUFF NOW

confirmation modal for delete library

currently when using an external player, the player is forked from waverunner and is a child of it, therefore when you close waverunner, the player closes. This should not be the case.

Okay so right now, the toasts that appear kinda overlap on top of the create library modal when theyre both up. I'd like to add more space between the modal and the top and bottom of the app. Try doubling it or something close. Also the modal needs to be scrollable. its already long and might get longer
