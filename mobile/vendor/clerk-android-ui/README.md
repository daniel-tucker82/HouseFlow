# Clerk Android authentication scrolling patch

Clerk Android UI 1.3.0 lays out authentication content in a non-scrolling Column.
On Cyntch's Pixel 6 landscape emulator the email field appeared, but the Continue
button was compressed to a thin strip and disappeared from the accessible tree.
The published 1.4.1 source has the same scaffold, so upgrading alone is not a fix.

This included Gradle build compiles the **published 1.3.0 sources**, using its
original resources and consumer rules. `ClerkThemedAuthScaffold.kt` scrolls within
the scaffold padding and accounts for the keyboard. `ClerkButton.kt` and
`ClerkSocialButton.kt` use minimum heights rather than fixed heights, so scaled
text and content padding can grow together. This follows an observed clipped
Google sign-in label at 1.6x text on the Pixel Tablet in run `41836733823`.
Authentication logic, field sizing and navigation remain upstream code.
No fixed content height is assumed. Upstream
auth scaffold callers contain no nested vertical scroll containers.

The Expo config plugin substitutes only `com.clerk:clerk-android-ui:1.3.0`, and
rejects a different Expo bridge version until this patch is reviewed. Gradle
downloads the Maven Central source JAR and AAR, verifies their SHA-256 hashes,
and generates patched sources under `build/`. The AAR's compiled classes are
never used in the replacement. The checked-in before/after fragments must match
exactly once; button replacements also check their expected occurrence counts.
Build artifacts and downloaded sources are not committed.

The build uses the upstream Kotlin/Compose/serialization compiler 2.4.21 in an
isolated included build, AGP 9.2.1 to match React Native 0.88, and Java 17 to match
Cyntch's Android toolchain. Dependency versions mirror the upstream 1.3.0 POM
and build script. The API stays at 1.3.0, matching the account-cleanup adapter.
Clerk's MIT license is included in the application's assets.

Validation must include the compiled replacement in the optimized application,
phone/tablet portrait and landscape, enlarged text, keyboard use, and all
enabled authentication stages. Compilation alone is insufficient. The shared
Maestro flow scrolls to the rendered Continue label and requires its action ID.
Android also captures the Google button in both orientations at each text size.
Screenshot dimensions are verified, and visual review must confirm uncut labels.
CI retains all three patched sources and the compiler logs.

Once an upstream release contains equivalent scrolling, remove this included
build and config plugin only after verifying those device journeys against the
new release. Review the native account-cache adapter's version pins together.

Sources:
- https://repo.maven.apache.org/maven2/com/clerk/clerk-android-ui/1.3.0/
- https://github.com/clerk/clerk-android/blob/v1.3.0/source/ui/build.gradle.kts
- https://github.com/clerk/clerk-android/blob/v1.3.0/LICENSE
