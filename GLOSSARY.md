# Video to ASCII

Converting a source video into an ASCII video with an adjustable visual appearance.

## Language

**Source video**:
The video a user provides for conversion into ASCII.
_Avoid_: Original, upload

**ASCII video**:
A video whose frames represent the source video's imagery as a regular grid of text characters, selected according to the brightness of each region.
_Avoid_: ASCII animation, text video

**ASCII code output**:
A versioned bundle of actual character-frame data and a reusable standalone player, generated locally from a source video.
_Avoid_: code video, text animation

**Density**:
The number of character columns across an ASCII video frame. Higher density represents the source video with finer detail.
_Avoid_: Resolution, font size

**Character preset**:
A built-in selection of characters ordered by visual weight, used to represent different brightness levels in an ASCII video.
_Avoid_: Font, theme

**Source-color mode**:
A rendering mode in which each character takes its color from the corresponding region of the source video. The background color remains independently selectable.
_Avoid_: Original colors, automatic colors

**Inversion**:
Reversal of the brightness-to-character mapping. Inversion changes which characters represent light and dark regions without swapping the chosen colors.
_Avoid_: Color inversion, negative
