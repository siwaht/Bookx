# Code Scaffold — Audiobook Maker

## Repo Layout
```
audiobook-maker/
├── client/                    # React frontend
│   ├── src/
│   │   ├── components/        # Reusable UI components
│   │   ├── pages/             # Dashboard, Manuscript, Voices, Timeline, QC, Export
│   │   ├── hooks/             # Custom React hooks
│   │   ├── services/          # API client functions
│   │   ├── stores/            # Zustand state stores
│   │   ├── timeline/          # Canvas timeline engine
│   │   ├── audio/             # WebAudio playback engine
│   │   ├── types/             # TypeScript types
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   └── package.json
├── server/                    # Node.js backend
│   ├── src/
│   │   ├── routes/            # Express route handlers
│   │   ├── services/          # Business logic
│   │   ├── elevenlabs/        # ElevenLabs API adapter
│   │   ├── render/            # FFmpeg render engine
│   │   ├── export/            # ACX export builder
│   │   ├── db/                # SQLite setup + queries
│   │   ├── middleware/        # Auth, error handling
│   │   ├── utils/             # Helpers
│   │   ├── types/             # TypeScript types
│   │   └── index.ts           # Entry point
│   ├── tsconfig.json
│   └── package.json
├── data/                      # Runtime data (gitignored)
│   ├── audio/                 # Generated audio files
│   ├── exports/               # Export packages
│   └── db.sqlite              # SQLite database
├── docs/                      # Design documents
├── package.json               # Root workspace
├── .env.example
└── README.md
```

## Tech Stack Justification

| Choice | Why |
|--------|-----|
| React + TypeScript | Best ecosystem for complex UI (timeline), strong typing |
| Vite | Fast dev server, good for Replit |
| Zustand | Lightweight state management, good for timeline state |
| Canvas API | Required for performant waveform rendering at scale |
| WebAudio API | Low-latency browser audio playback, mixing, analysis |
| Node.js + Express | Same language as frontend, good for streaming proxying |
| better-sqlite3 | Synchronous SQLite for Node, fast, zero-config, Replit-friendly |
| FFmpeg (fluent-ffmpeg) | Industry standard for audio processing, loudness normalization |
| mammoth | DOCX → HTML/text extraction |
| marked | Markdown parsing |
| archiver | ZIP file creation for exports |
| node-id3 | MP3 ID3 tag writing |
| crypto (built-in) | SHA-256 hashing for cache keys |

## Core Libraries
```json
{
  "client": {
    "react": "^18",
    "react-dom": "^18",
    "zustand": "^4",
    "react-router-dom": "^6",
    "@tanstack/react-query": "^5",
    "lucide-react": "icons"
  },
  "server": {
    "express": "^4",
    "better-sqlite3": "^11",
    "mammoth": "^1",
    "marked": "^14",
    "fluent-ffmpeg": "^2",
    "archiver": "^7",
    "node-id3": "^0.2",
    "multer": "^1",
    "cors": "^2",
    "dotenv": "^16"
  }
}
```
