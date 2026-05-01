# HouseFlow Mobile Handoff Checklist

This checklist contains all remaining manual actions needed to ship the native mobile app.

## 1) Accounts and Access

- [ ] Apple Developer Program account (paid) with access to Certificates, Identifiers, and Profiles.
- [ ] Google Play Console account with app publishing access.
- [ ] Firebase project with admin permissions.
- [ ] Access to a macOS machine with Xcode installed (required for iOS builds/signing).

## 2) Environment Variables

Set these in the runtime environment where HouseFlow backend API runs:

- [ ] `CAPACITOR_SERVER_URL` set to the deployed HTTPS app URL.
- [ ] One of:
  - [ ] `FIREBASE_SERVICE_ACCOUNT_JSON`, or
  - [ ] `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`

Optional existing web push vars remain in use for browser push:

- [ ] `WEB_PUSH_VAPID_PUBLIC_KEY`
- [ ] `WEB_PUSH_VAPID_PRIVATE_KEY`
- [ ] `WEB_PUSH_CONTACT_EMAIL`

## 3) Database

- [x] Run migration `database/0012_mobile_push_tokens.sql`.
- [ ] Run the same migration in every non-local environment (staging/prod).

## 4) Firebase Setup

### Android app in Firebase

- [ ] Create Android app in Firebase using package ID `com.houseflow.app` (or your chosen final ID).
- [ ] Download `google-services.json`.
- [ ] Place `google-services.json` in `android/app/`.
- [ ] Ensure Firebase Cloud Messaging is enabled.

### iOS app in Firebase

- [ ] Create iOS app in Firebase using bundle ID `com.houseflow.app` (or your chosen final ID).
- [ ] Download `GoogleService-Info.plist`.
- [ ] Add `GoogleService-Info.plist` to `ios/App/App/` in Xcode.
- [ ] Configure APNs key/certificate in Firebase project settings.

## 5) Apple Push + Signing (Manual in Apple portals/Xcode)

- [ ] Create iOS App ID / Bundle ID.
- [ ] Enable Push Notifications capability for the App ID.
- [ ] Create APNs authentication key (preferred) or certificate.
- [ ] Upload APNs credentials to Firebase.
- [ ] Configure team/signing in Xcode for Debug + Release.
- [ ] Create provisioning profiles.

## 6) Android Signing + Release

- [ ] Generate/retrieve Android upload keystore.
- [ ] Configure signing in Android Studio (`build.gradle`/`gradle.properties` as needed).
- [ ] Configure Play App Signing in Play Console.

## 7) Build and Device Testing

### Android

- [ ] `npm run mobile:sync`
- [ ] `npm run mobile:open:android`
- [ ] Build and run on physical Android device.
- [ ] Login, perform in-app action that generates notification, confirm push received.
- [ ] Tap push and confirm deep-link routing into app.

### iOS (macOS only)

- [ ] `npm run mobile:sync`
- [ ] `npm run mobile:open:ios`
- [ ] Build and run on physical iPhone.
- [ ] Accept notification permission prompt.
- [ ] Confirm push delivery and deep-link behavior from notification tap.

## 8) Store Listing + Compliance

- [ ] Prepare app icons/screenshots for iOS and Android store listings.
- [ ] Fill App Privacy (Apple) and Data Safety (Google Play) forms.
- [ ] Add terms/privacy URLs as required.
- [ ] Validate notification permission copy and app description language.

## 9) Release Workflow

- [ ] Set up TestFlight internal testing.
- [ ] Set up Play internal testing track.
- [ ] Run pilot with real users/devices and confirm notification reliability.
- [ ] Promote to production tracks after pilot sign-off.

## 10) Post-Release Operations

- [ ] Monitor backend logs for token registration/unregistration errors.
- [ ] Monitor push delivery failures (`invalid-registration-token`, APNs errors).
- [ ] Rotate Firebase/Apple keys with documented runbook.
- [ ] Keep Capacitor iOS/Android dependencies updated.
