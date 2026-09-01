# TODO

## test on prod



## now


## bugs / needs fixing

this may already be in here already but the settings menu is comically narrow for some reason

when scrolling all the way down on people page then scrolling back up relatively quickly, the app fairly reliably freezes to the point where I have to close it in task manager. im assuming because theres so many or something, idk. theres 14.8K people in my library

consider volume equalization methods like how Apple/Spotify match all tracks -14DBFS volume. Consider making this equalization optional in settings and maybe allow user to choose level of equalization

seems like opening settings modal when window is small causes the modal to overflow horizontally. need to figure something out here (this may be fixed on dev by now, idk, but on prod its happening)

i want 'indeterminate time remaining' on the scan phase like how 'about X minutes remaining' is on match phase

new breadcrumbs functionality. it should just follow the user always. even when creating duplicates in history. the only thing that should reset it is clicking an option in the sidebar. overflow should not create scroll but follow the most recent - when going back by breadcrumbs, and if the breadcrumbs are overflowing, only show the next forward history to the clicked breadcrumb. for instance, if the user has really been digging and there are 30 things in the breadcrumbs: for one, it would definitely be overflowing. the user should also see the most recent fitting ones, and the cut off on the left side of the breadcrumbs section would ideally begin with an ellipsis (still a button tho). Say the user clicks the breadcrumb 4 options back from the most recent. there were 3 in front, say the breadcrumbs were numbered like so: 5 - 4 - 3 - 2 - 1, and the user clicked 4. since the breadcrumbs are overflowing, only 3 should show in front of 4, and greyed out (STILL A BUTTON). I want to always focus on showing previous history over forward history, so when the breadcrumbs are overflowing and the user has forward breadcrumbs, always only show the 1 closes to where the user clicked. The user can nav all the way forward by continually clicking the 1 forward history button until there is no more. im somewhat spitballing here just to have something to record my idea before I forget. what do you think about this one?

make play button on movies/shows (as well as episode specific play buttons) show a loader if it takes longer than .2 seconds to bring up the player. sometimes the drive has to spin up

trying to close app mid scan causes native alert to appear. need to use waverunner style modal.

i renamed a folder from my source library and went and tried to play the song in waverunner and it definitely isnt ready for that, although i thought it'd be worse. the song appears to start playing at first but its stuck at 0:00 and shows the pause button like its playing and wont switch to play by clicking - its just stuck there.

make rows on home page for libraries being scanned show 'scanning...' or 'matching...' with a loader, under the header, instead of the usual content

noticed something when matching the release of THat Part by schoolboy Q. At first it said the album was by schoolboy Q and Kanye and the track was just Q. When I matched the release it flipped them. actually look into versions where Kanye is not on the song because he isnt on my track.

deal with some artists getting weird white background person icon placeholder image

maybe have a thing at the end of scan/matching passes (aside from the very first one) that lists what the last pass did.

show "+ N more releases" on artist page in detail view on albums with more than 1 release

consider how to deal with separating release-group and release release-dates on album pages.

scanning libraries in sidebar should be limited to three lines and cut off with ellipsis if necessary. then let entry slot expand to 3 lines worth of space even when not needed so that sidebar isn't jumping up and down during rescan due to length changes in progress indicator as scanner progresses

consider per-album display-title choice: release group name vs default release's name (e.g. DAMN. vs DAMN. COLLECTORS EDITION.). needs MB release titles stored on album_release; choice as field_override; materialize on toggle and recompute on release apply / default-release switch / unmatch. manual rename is the stopgap.

need better modal stacking system - its a little crazy right now. consider animations for size differences when switching between modals.

find good hover tooltip styling and apply it everywhere

less rounded previous, next, play/pause buttons on video player

account for intentionally incomplete albums

make movies/tv covers on home page same width as music covers

add gradients to screens and modals at the top and bottom where scrollable areas touch the edge of their window

I was watching stranger things on prod and I noticed it wouldnt go into 'continue watching' when I closed it. i think it has something to do with me having marked it as watched previously - idk. either way, if something is played after being marked as or considered 'watched' it should become unwatched again until the user either watches it fully or remarks it as watched.

any  way we could do a rough estimated total time on library creation/rescan (especially creation)

dont allow user to click create button on create library menu until they have scrolled all the way down at least once

i noticed navigating forward and back is working while metadata center is open. it shouldnt. it shouldnt work with any modal open unless the modal has its own nav.

consider who loved tracks apply to. it should (and I believe is) apply to all album artists the track comes from. this is the part that i think will take a change: I also want artists credited on the loved track to be credited with loves even if they are not an artist on the album, just a feature. Pretty sure loves dont yet apply to track features. this should line things up with how loose track loves work.

during playback, cursor doesnt disappear when left hovered over prev, next, and play/pause icons

throughout waverunner (music only), replace usage of word 'appearance/appearances' with 'feature/features'

dead code removal run

exiting create library scanner then restarting it in sidebar removes ability to stop again. Also the scanning library in the sidebar can't exit it either because the context menu options for a scanning library are basically nothing, just 'create library'. also sometimes clicking stop and exit takes a while. if theres background processing to be done I get that but hide it from the user and delete the library from the UI quickly upon request

i deleted a library then went to create it again and it pulled up the metadata center and an error saying something along the lines of 'continue import first'. I went to recreate the library quickly after deleting and I think I caught it mid processing, which caused that undefined behavior. plz fix

allow ctrl+click and shift+click tracks for multiselect (for multi-queue, multi-add-to-playlist, etc)

breadcrumbs seem to be messed up. starting from Albums page, when I go to an album, then click on the artist of the album, the breadcrumbs that show there is "library - Albums > artistname". It should be something like "library - Albums > album_name > artist_name" or "library - Artist > artist_name" whichever tracks more with our current system and how video libraries work. I think this would mean the former option.

continue watching needs to remember if subtitles are on and which are being used

sometimes adding covers (for sure at least from the albums grid page) doesnt stick. I add it, I can see it at first, but if I go away and come back, the cover will be gone, sometimes only gone on the grid page and visible on the album page, sometimes gone from both. even a refresh doesnt fix it sometimes. actually it seems a cover I added is only showing on the individual album page, not the albums grid page. it seems to show everywhere except albums grid page.

editing loose tracks to give them an artist doesn't seem to update the artist page with the new track. I can even click on the artist under the track to get to the page but it isn't there.

i noticed an album rename didnt update its location until refresh OR go away and come back. it should visibly (animatedly) move to its new location immediately after rename. ACTUALLY, now I'm noticing that renaming albums through the context menu from right clicking albums on the albums page isnt working. it seems to work at first but eventually you come back and its back to the old name

while combining an album I went to an album page (by clicking the album of the currently playing song), and the modal for selecting an album to combine with appeared. not sure why. i exited it and continued what I was doing. the albums seemed to merge properly. not sure what wouldve happened had i done something in that erroneous modal. plz fix. now that I think of it, I realize I wasnt supposed to be able to go there while rescanning. we need to consider what to do with whats currently playing while rescanning.

WHOLE MUSIC SECTION NEEDS CONTEXT MENU IMPROVEMENTS


## changes / small new features

settings checkbox for volume percentage display during playback

music and sound video player: handle music videos as well as sounds that come with videos (asmr in my case). we'll get into discussion about this when time comes but some tracks have optional videos that should be watchable if desired. For tracks that have video, maybe just add another play button to watch the video alongside the audio. double clicking and any existing form of playing tracks should just play the audio normally. The existing video player can basically be used exactly as it functions in video libraries - there are a couple exceptions like I dont think it needs autoplay toggle or subtitle selection or audio track selection but other than that...

ADHD mode: toggle in settings to allow video and music to be played at the same time

export media covers zip

personal movie/show ratings

switch to skeleton loaders

button somewhere to open source folders, maybe some as well per media

display images (png, jpg, webp, gif, etc) in extras, alongside the video extras (featurettes, webisodes, deleted scenes, etc). Right now the extras scanner only picks up VIDEO files in the reserved extra dirs (collect_extra_files filters is_media_file(VIDEO_EXTENSIONS)); extend it to also collect image files (IMAGE_EXTENSIONS) and store them as extras with a type/kind that distinguishes image vs video. The extras dialog then renders image extras in an image viewer / gallery (lightbox) instead of launching the player, while video extras keep playing as they do now. Use case: promotional stills, behind-the-scenes photos, concept art, posters. (Covers/backgrounds folders are already handled separately as artwork — this is images that live in the extra-content folders, or a dedicated images/stills folder.)


## new features

multi track player - play multiple audio tracks (and a video track if desired) at the same time. multi track player should have entire UI for controlling multiple playing tracks at once

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
