# TODO

## test on prod



## now

account for intentionally incomplete albums

account for rescan necessity after merging/decsions-made/actions-etc in review


## bugs / needs fixing

playlist (both music and video libraries) sort mode switching isnt animated like other pages. it should be

allow ctrl+click and shift+click tracks for multiselect (for multi-queue, multi-add-to-playlist, etc)

add little Xs to the right side of search bars to clear the search back to empty

on individual artist page, make album cover size same on grid view as they are on detail view

breadcrumbs seem to be messed up. starting from Albums page, when I go to an album, then click on the artist of the album, the breadcrumbs that show there is "library - Albums > artistname". It should be something like "library - Albums > album_name > artist_name" or "library - Artist > artist_name" whichever tracks more with our current system and how video libraries work. I think this would mean the former option.

i have Sneakin by Drake & 21 Savage loved but its not being counted on the artist page sorted by most loved. 21 Savage should have 2 loved as the subtitle (I have another song of his loved as well (on prod)) but it just has 1 loved. same with Future on What a Time to be Alive. seems like the 'main artist' thing is creeping up. Albums/tracks should be able to have multiple 'main' artists.

continue watching needs to remember if subtitles are on and which are being used

sometimes adding covers (for sure at least from the albums grid page) doesnt stick. I add it, I can see it at first, but if I go away and come back, the cover will be gone, sometimes only gone on the grid page and visible on the album page, sometimes gone from both. even a refresh doesnt fix it sometimes. actually it seems a cover I added is only showing on the individual album page, not the albums grid page. it seems to show everywhere except albums grid page.

go over '191' matched albums and ensure automatching process is solid

metadata center "N matched - M not found" needs to say "N albums matched - M not found"

seems like artists that request to merge on initial scan review come up in first rescan to be matched. we should deal with that in review on the inital scan, not on next rescan

clicking something on home page from a library that is being rescanned should have a toast pop up saying that cant be done right now instead of just not working

track, artist, and album need to be links on playlist page

oldest-first/newest-first doesn't seem to be working on artist pages on grid view

editing loose tracks to give them an artist doesn't seem to update the artist page with the new track. I can even click on the artist under the track to get to the page but it isn't there.

make listen count updates not need refresh

i noticed an album rename didnt update its location until refresh OR go away and come back. it should visibly (animatedly) move to its new location immediately after rename. ACTUALLY, now I'm noticing that renaming albums through the context menu from right clicking albums on the albums page isnt working. it seems to work at first but eventually you come back and its back to the old name

while combining an album I went to an album page (by clicking the album of the currently playing song), and the modal for selecting an album to combine with appeared. not sure why. i exited it and continued what I was doing. the albums seemed to merge properly. not sure what wouldve happened had i done something in that erroneous modal. plz fix. now that I think of it, I realize I wasnt supposed to be able to go there while rescanning. we need to consider what to do with whats currently playing while rescanning.

deleting libraries should require typing the name of the library. needs more confirmation

WHOLE MUSIC SECTION NEEDS CONTEXT MENU IMPROVEMENTS


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
