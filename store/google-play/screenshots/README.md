# Cyntch Play listing captures

These images came from the native Android application using a fictional household,
on 8 November 2026 (Sydney). They are ready for editorial review; they have not
been uploaded to Play. The PNGs contain the emulator framebuffer, with no screen
compositing, labels or redaction. Each saved file was decoded and its RGB pixels
compared against the original after removing the opaque alpha channel.

| Capture | What is visible | Size |
| --- | --- | --- |
| [Today](phone-today.png) | The family's shared task list and progress | 1080 × 1920 |
| [Routines](phone-routine.png) | A weekly routine, its actions and schedule | 1080 × 1920 |
| [Notifications](phone-notifications.png) | Completion alerts selected for Ava alone on this phone | 1080 × 1920 |
| [Family display](tablet-family-display.png) | The locked landscape board for Ava, Ben and Mia, with protected parent access | 2560 × 1600 |

Capture source: `e69cb71`, on dedicated phone and tablet emulators. The native
screen source, assets, shared mobile code and mobile package dependencies match
the signed Android bundle's source `c71518d`. These captures used the local
development build and an isolated server, not a Play-installed binary.
No real household, purchase or notification delivery is depicted.
