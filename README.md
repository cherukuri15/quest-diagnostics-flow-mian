# Quest × Pronix.ai — call flow review site

This small website shows the Test Results AI Agent call flows behind one shared login. Anyone who signs in can leave comments on any step, or on the whole page, and everyone sees the same comments because they are stored in MongoDB.

## What's in this folder

| File | What it does |
| --- | --- |
| `server.js` | The web server: login, logout, and the comments API |
| `public/index.html` | The call-flow page (Blueprint Session 2) |
| `public/login.html` | The sign-in page |
| `scripts/hash-password.js` | Turns your shared password into a secure hash for `.env` |
| `.env.example` | Template for your secret settings |
| `package.json` | The list of libraries the server needs |

## What you need

- **Node.js 18 or newer.** Download it from nodejs.org. Check with `node -v`.
- **A free MongoDB Atlas account.** Sign up at mongodb.com/atlas.
- **Somewhere to host it**, so the client can open a link. Step 5 uses Render, which has a free plan.

---

## Step 1 — Create the MongoDB database (about 10 minutes)

1. Sign in to **MongoDB Atlas** and create a project, for example "Quest flow review".
2. Click **Create** and choose the free **M0** cluster. Pick a US region and click **Create Deployment**.
3. **Create a database user.** Atlas asks for one straight away. Choose a username, for example `flowreview`, and click **Autogenerate Secure Password**. Copy both somewhere safe; you need them in Step 2.
4. **Allow network access.** Go to **Security → Network Access → Add IP Address**.
   - To test on your own computer, choose **Add Current IP Address**.
   - For Render or any cloud host, choose **Allow Access from Anywhere** (`0.0.0.0/0`), because their IP addresses change. The database is still protected by the user and password from step 3.
5. **Get the connection string.** Go to **Database → Connect → Drivers**, choose **Node.js**, and copy the string. It looks like this:

   ```
   mongodb+srv://flowreview:<db_password>@cluster0.abcde.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0
   ```

   Replace `<db_password>` with the password from step 3. If the password contains symbols such as `@`, `/` or `:`, autogenerate a new one without them, or URL-encode them.

You don't need to create any collections. The server creates `comments` and `sessions` itself the first time it starts.

## Step 2 — Fill in your `.env` file

1. In this folder, copy `.env.example` to a new file called `.env`.
2. Open a terminal in this folder and install the libraries:

   ```bash
   npm install
   ```

3. Choose the shared username and password you'll give the client. Then make the password hash:

   ```bash
   npm run hash-password -- "Choose-A-Strong-Shared-Password-2026"
   ```

   It prints a line starting with `APP_PASSWORD_HASH=`. Paste that line into `.env`, keeping the single quotes.
4. Make the session secret:

   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

   Paste the output into `.env` as `SESSION_SECRET=`.
5. Paste your MongoDB connection string from Step 1 into `MONGODB_URI=`.

A finished `.env` looks like this (with your own values):

```
MONGODB_URI=mongodb+srv://flowreview:Xy7...@cluster0.abcde.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB=quest_flow_review
APP_USERNAME=quest-review
APP_PASSWORD_HASH='$2a$12$7c3N...'
APP_PASSWORD=
SESSION_SECRET=9f1c2b...
SESSION_HOURS=12
PORT=3000
NODE_ENV=development
TRUST_PROXY=0
```

`.env` holds all your secrets. It's listed in `.gitignore`, so it never goes to GitHub. Don't email it or paste it into chats.

## Step 3 — Run it on your computer

```bash
npm start
```

You should see:

```
Connected to MongoDB database "quest_flow_review".
Flow review running on http://localhost:3000
```

Open http://localhost:3000, sign in with the shared username and password, click a box, and add a comment. Then open the site in a second browser (or a private window), sign in again, and check that the comment is there.

If it doesn't start, see Troubleshooting below.

## Step 4 — Put the code on GitHub

1. Create a **private** repository on GitHub.
2. Push this folder to it. `.env` and `node_modules` are skipped automatically.

## Step 5 — Host it on Render so the client can open a link

1. Sign in at render.com with GitHub and click **New → Web Service**.
2. Pick your repository and set:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Health check path:** `/healthz`
3. Under **Environment**, add every line from your `.env` as a separate variable, with two changes:
   - `NODE_ENV` = `production`
   - `TRUST_PROXY` = `1`
   - Leave out `PORT`, because Render sets it.
   - For `APP_PASSWORD_HASH`, paste the hash **without** the single quotes.
4. Click **Create Web Service**. After a few minutes Render gives you a link like `https://quest-flow-review.onrender.com`.
5. Open the link, sign in and add a test comment.

Render's free plan sleeps after about 15 minutes without visitors, so the first visit afterwards takes up to a minute to load. A paid plan keeps it awake. Railway, Azure App Service or any Node host works the same way: set the same environment variables and run `npm start`.

## Step 6 — Share it with the client

Send the link plus the shared username and password, ideally in separate messages. Everyone who signs in can:

- click any box to read the step, and use **＋ Add comment** with their name and comment
- click **💬 Comments** at the top to see all comments, filter Open / Resolved / All, and jump to the step a comment is about
- resolve or reopen any comment, and delete their own

New comments from other people appear within about 15 seconds, or straight away when you switch back to the tab.

---

## Everyday tasks

**Change the shared password.** Run `npm run hash-password -- "NewPassword"`, put the new hash in `APP_PASSWORD_HASH` (in `.env` and on Render), and restart. Everyone has to sign in again with the new password once their current login expires; to force it straight away, delete the documents in the `sessions` collection in Atlas.

**Export all comments.** In Atlas, open **Database → Browse Collections → quest_flow_review → comments**, then use **Export Collection** (or MongoDB Compass) to save them as JSON or CSV.

**Start a fresh review round.** Export the comments first, then delete the documents in the `comments` collection.

## How it works

- **Login.** One username and password, set in `.env`. The password is stored as a bcrypt hash, never as plain text. After signing in, the browser gets a secure, http-only cookie that lasts `SESSION_HOURS` hours. Ten failed sign-ins from one address lock that address out for 15 minutes.
- **Comments.** Stored in the `comments` collection with the step, the name typed by the commenter, the text, the time and whether it's resolved. Because everyone shares one login, each browser gets its own random ID so people can delete only the comments they wrote.
- **Edit mode** is turned off on this site, so reviewers can comment but can't change the flow.

## Security notes

- Always use the `https://` link in production; `NODE_ENV=production` makes the login cookie work only over HTTPS.
- A shared login can't tell people apart, so the name on a comment is whatever the person types. If you need to know exactly who said what, you'd need individual logins.
- Ask reviewers **not to put patient information** (names, dates of birth, account numbers) in comments. This site is for reviewing the flow design, not real calls.

## Troubleshooting

| Message or problem | Fix |
| --- | --- |
| `Missing settings in .env` | `.env` is missing or a value is empty. Compare it with `.env.example`. |
| `SESSION_SECRET must be at least 32 characters` | Generate one with the command in Step 2. |
| `Could not start: ... querySrv ENOTFOUND` | The connection string is wrong. Copy it again from Atlas. |
| `Could not start: ... bad auth` | The database username or password in `MONGODB_URI` is wrong, or the password has unencoded symbols. |
| `Could not start: ... Server selection timed out` | Your IP isn't allowed. Add it in Atlas → Network Access (or allow `0.0.0.0/0` for cloud hosts). |
| Sign-in keeps returning to the login page on Render | Make sure `NODE_ENV=production` and `TRUST_PROXY=1` are set, and that you're using the `https://` link. |
| "That username or password isn't right" | Check `APP_USERNAME`, and that the hash on Render has no quotes around it. |
