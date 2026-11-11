# Publishing the app so that other people can use their own cloud accounts

The cloud backup signs the user in to their own Google Drive, OneDrive or Dropbox account through an OAuth
"application" that the developer registers once with each provider. While that registration is in a test or
development state only named testers can sign in (and, with Google, their sign-in lapses after seven days).
Publishing it lifts those limits. The provider needs three public pages for this: the app's home page, a privacy
policy and terms of service. The `site/` folder holds them; this file is the procedure.

## 1. Put the three pages online

Google and Dropbox must be able to open the pages, so they have to be on a public website whose domain you
control. GitHub Pages on a public repository is free and enough (this project's repository is private, and Pages
on a private repository needs a paid plan, so the site gets its own small public repository):

1. On GitHub create a new **public** repository, for example `investment-tracker` (nothing in it).
2. Fill `site/` in: replace `[your name]`, `[your contact email]` and `[your city]` in the three HTML files.
3. Push the folder's contents as that repository's root:

   ```
   cd site
   git init -b main
   git add .
   git commit -m "Investment Tracker site"
   git remote add origin https://github.com/doonsMonk/investment-tracker.git
   git push -u origin main
   ```

4. In that repository: **Settings → Pages → Source: Deploy from a branch → main / (root) → Save**. After a minute
   the pages are at:

   | Page | URL |
   |---|---|
   | Application home page | `https://doonsmonk.github.io/investment-tracker/` |
   | Privacy policy | `https://doonsmonk.github.io/investment-tracker/privacy.html` |
   | Terms of service | `https://doonsmonk.github.io/investment-tracker/terms.html` |

   (If the repository gets another name, replace `investment-tracker` in all three.)

5. Prove the domain to Google once: open [Google Search Console](https://search.google.com/search-console),
   add a **URL-prefix** property for `https://doonsmonk.github.io/investment-tracker/`, choose the **HTML file**
   method, put the file it gives you into `site/`, push, and click **Verify**. Google's consent screen only
   accepts "authorized domains" that are verified this way.

## 2. Google: register and publish the app

All of this is in the [Google Cloud console](https://console.cloud.google.com/) under your personal Google
account (not a company account).

1. **Create a project** (top bar → project picker → New project), for example "Investment Tracker".
2. **Enable the Drive API**: APIs & Services → Library → "Google Drive API" → Enable.
3. **Configure the consent screen** (APIs & Services → OAuth consent screen; in the newer console this is
   "Google Auth Platform → Branding / Audience"):
   - User type / audience: **External**.
   - App name: `Investment Tracker`. User support e-mail: your address.
   - App logo: optional (`android/app/src/main/res` has the icon). Uploading a logo makes Google ask for brand
     verification, which can take weeks; leave it out for now.
   - Application home page, privacy policy link, terms of service link: the three URLs from step 1.
   - Authorized domains: `doonsmonk.github.io`.
   - Developer contact e-mail: your address.
4. **Scopes** (the "Data access" page): Add or remove scopes → tick `https://www.googleapis.com/auth/drive.file`
   ("See, edit, create, and delete only the specific Google Drive files you use with this app") → Update → Save.
   This is a *non-sensitive* scope: an app that uses only non-sensitive scopes can be published without Google's
   verification review, and users do not see an "unverified app" warning.
5. **Publish**: on the consent screen / Audience page, **Publishing status: Testing → Publish app → Confirm**.
   The status becomes **In production**. That is the whole publication for a non-sensitive scope; there is
   nothing to submit.
6. **Create the OAuth client** (APIs & Services → Credentials → Create credentials → OAuth client ID):
   application type **Desktop app**, name "Investment Tracker". Google shows a **client ID** and a **client
   secret**; keep both. A desktop client accepts the app's loopback return address
   (`http://127.0.0.1:<port>/api/cloud/callback`) on any port, which is what the PC and the Android app use.
   For an installed app Google does not treat the secret as confidential; it may be shipped inside the app.

What users see from then on: Google's normal sign-in, then "Investment Tracker wants to: See, edit, create and
delete only the specific Google Drive files you use with this app", with your home page and privacy policy linked.

## 3. OneDrive and Dropbox (when wanted)

- **OneDrive**: [Azure portal](https://portal.azure.com/) → App registrations → New registration: name
  "Investment Tracker", supported account types **Personal Microsoft accounts only**, redirect URI type
  **Mobile and desktop applications** with `http://127.0.0.1`; under Authentication allow public client flows;
  API permissions: Microsoft Graph delegated `Files.ReadWrite.AppFolder` and `offline_access`. Personal-account
  apps need no publishing step; there is only the client ID (no secret). The branding page can carry the same
  three URLs.
- **Dropbox**: [App console](https://www.dropbox.com/developers/apps) → Create app → Scoped access → **App
  folder** → name "Investment Tracker"; permissions `files.content.write`, `files.content.read`,
  `files.metadata.read`, `account_info.read`; OAuth 2 redirect URI `http://127.0.0.1:8000/api/cloud/callback`.
  A new app is in **Development** status, which allows up to 50 users; **Apply for production** on the app's page
  asks for the app's description and the same pages, and Dropbox reviews it (usually a few days).

## 4. Give the app the client to use

Today each user pastes the client ID (and, for Google, the secret) in the app's **Cloud → Set up…** dialog, which
stores them in `settings.json`. For people you share the builds with, send them the client ID and secret to paste
in, or ask for a build with the client built in: the backend reads a default from the build so that the dialog's
Set up step disappears for Google. Keep the client ID and secret out of the public site and out of this
repository's public parts; they are only ever yours to hand over.

## 5. Keep the pages true

The privacy policy describes what the app does today: the price services it calls, the scope it asks for, the
files it writes, the tokens it keeps. When one of those changes, change the page and its effective date.
