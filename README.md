# Alt Image Zoom Modal

Unpacked Chrome extension that opens a zoomable image modal when you Alt-click an image on any page.

## Features

- Alt-click any `<img>` to open the viewer.
- Collects visible page images into a thumbnail carousel.
- Saves images into extension-owned folders backed by IndexedDB.
- Extension popup lets you create folders and browse saved images after leaving the original page.
- Fit-to-stage default view.
- Mouse wheel zoom anchored at the pointer.
- Button and keyboard zoom anchored at the viewport center.
- Pointer drag panning.
- Double-click or `0` reset.
- Previous/next navigation with buttons, thumbnails, and arrow keys.
- Copy image to clipboard when the browser and image source allow it.
- Download image with a sanitized filename.
- `Escape` closes the modal.

## Image Folders

- Click the extension toolbar icon to open the folder browser.
- Create folders from the popup.
- Use the modal's **Save** control to save the active image into a selected folder.
- Right-click an image and choose **Save image to Inbox** for a fast default save.

## Install As Unpacked Extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `/Users/byronwall/Projects/chrome-image-modal`.

## Notes

Some sites block cross-origin image fetches. In those cases viewing still works, but copy or download can fail because Chrome cannot fetch the image as a blob from the page context.
