# CaiShen 

**Prerequisite:** make sure [Node.js](https://nodejs.org) is installed and up to date.

You need **two consoles (terminals) open at the same time** — one for the backend, one for the frontend. In each, `cd` into the correct folder as shown below.

### First-time setup — install dependencies
The project root and the `client` folder are separate npm projects, so install in **both**:

```bash
# from the project root
npm install
cd client
npm install
cd ..
```

### Console 1 — Backend (run from the project root)

```bash
npm start
```

Runs on http://localhost:3001

### Console 2 — Frontend (run from the `client` folder)

```bash
cd client
npm run dev
```

Runs on http://localhost:5173 — open this URL in your browser.
