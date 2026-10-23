# Process videos entirely on the user's device

The ASCII video converter will decode, render, and export videos locally in the browser, avoiding video uploads and server processing. We accept narrower browser and device compatibility in exchange for keeping videos on-device: the first version targets desktop Chrome and Edge, accepts H.264 MP4 input, and checks MP4 encoding capability before offering export. Unsupported files or devices receive a clear explanation; there is no server fallback.
