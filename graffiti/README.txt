Grimes Graffiti - draw on the walls of the 3D Grimes building model
====================================================================

FOR TEAM MEMBERS ONLY. The 3D model is made from the Grimes 360 photo dataset.

Run
  Online:  https://yoonoolee.github.io/fun-with-3d-buildings/graffiti/  (multiplayer)
  Windows: double-click start.bat
  Mac:     right-click start.command -> Open (the first time macOS asks for confirmation)
           or in Terminal: cd into this folder, then  python3 serve.py
  A browser tab opens (Chrome or Edge recommended). Keep the black window open while you play.
  Needs Python 3 (python.org) and an internet connection (the page loads three.js from a CDN).

Controls
  Look : drag to turn, WASD to move, Q/E down/up, mouse wheel forward/back, Shift or double-tap Up/W = faster
  Draw : press G or the Draw button, then paint on the walls with the left button; right-drag turns
  Undo : Undo button or Cmd/Ctrl+Z (removes your whole last drag); Clear my strokes removes all of yours
  Station list: jump to one of the 96 photo positions

Your drawings
  Multiplayer (when firebase-config.js is filled in): everyone's strokes appear live for everyone, and
  other people show up as colored balls with name tags. Only you can undo your own strokes.
  Without it, strokes are saved in your browser only. Export saves them to a .json file; others press
  Import to add them (strokes they already have are skipped).
  Testing multiplayer locally: in this folder run  firebase emulators:start --project demo-graffiti
  and open http://localhost:8000/?emulator
