# hermexVM agent instructions

## Required APK delivery after changes

After completing any feature, fix, refactor, dependency update, or configuration change in this repository:

1. Run the project verification gates:

   ```bash
   pnpm check
   pnpm smoke
   ```

2. Build a fresh Android APK using the installed Android toolchain:

   ```bash
   export JAVA_HOME=/home/you/android-toolchain/jdk-21.0.5+11
   export ANDROID_HOME=/home/you/.android-dev/sdk
   export ANDROID_SDK_ROOT="$ANDROID_HOME"
   pnpm app:apk
   ```

3. Copy the successfully built APK to the user's delivery folder, replacing the previous build:

   ```bash
   install -D -m 0644 \
     apps/hermes-chat/android/app/build/outputs/apk/debug/app-debug.apk \
     /home/you/mydata/hermexvm-debug.apk
   ```

4. Verify that `/home/you/mydata/hermexvm-debug.apk` exists and report its size and SHA-256 checksum.

Do not claim a change is complete or ready to ship if the APK build or copy failed. Documentation-only edits may skip rebuilding the APK unless they alter build, release, setup, or agent workflow instructions.
