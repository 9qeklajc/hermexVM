# hermexVM agent instructions

## Required APK delivery after changes

After completing any feature, fix, refactor, dependency update, or configuration change in this repository:

1. Run the project verification gates:

   ```bash
   pnpm check
   pnpm smoke
   ```

2. Build a fresh Android APK using an installed JDK 21 and Android SDK:

   ```bash
   : "${JAVA_HOME:?Set JAVA_HOME to a JDK 21 installation}"
   : "${ANDROID_HOME:?Set ANDROID_HOME to the Android SDK}"
   export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
   pnpm app:apk
   ```

3. Set a machine-local delivery path, then replace the previously delivered APK:

   ```bash
   : "${HERMEXVM_DELIVERY_APK:?Set HERMEXVM_DELIVERY_APK to the delivery path}"
   rm -f "$HERMEXVM_DELIVERY_APK"
   install -D -m 0644 \
     apps/hermes-chat/android/app/build/outputs/apk/debug/app-debug.apk \
     "$HERMEXVM_DELIVERY_APK"
   ```

   Run the removal only after the new APK build succeeds, so a failed build does not delete the last deliverable.

4. Verify that `$HERMEXVM_DELIVERY_APK` exists and report its size and SHA-256 checksum. Treat a missing file after the copy as delivery failure.

Do not claim a change is complete or ready to ship if the APK build or copy failed. Documentation-only edits may skip rebuilding the APK unless they alter build, release, setup, or agent workflow instructions.
