# zaire-sketch-mind

🎨 **AI-powered photorealistic design studio.** Transform sketches and ideas into stunning photorealistic renders.

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/node-18%2B-brightgreen)

## ✨ Features

- ⚡ **AI Image Generation** - Flux, DALL-E 3, Stable Diffusion XL support
- 📸 **Sketch Upload** - Support for JPG, PNG, WEBP formats
- 🎨 **Design System** - Tailored categories (Fashion, Architecture, Construction, Tech)
- 📱 **Gallery & History** - Public gallery with sharing and personal project history
- 💳 **Subscription Plans** - Free, Pro, and Enterprise tiers
- 🔄 **Real-time Updates** - WebSocket-powered progress tracking

## 🛠 Tech Stack

**Backend:**
- Express.js — REST API
- PostgreSQL — Persistent storage
- Redis — Caching & job queue
- Socket.IO — Real-time updates
- BullMQ — Background jobs
- Stripe — Payments

**Frontend:**
- HTML5 + CSS3 + JavaScript
- Tailwind CSS — Styling
- Socket.IO Client — WebSocket

**Infrastructure:**
- Docker & Docker Compose
- GitHub Actions — CI/CD
- Cloudflare R2 — Image storage

## 📦 Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL 14+
- Redis 7+
- Docker (optional)

### Installation

```bash
# Clone repository
git clone https://github.com/franklinmakana58-creator/zaire-sketch-mind.git
cd zaire-sketch-mind

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your settings

# Start with Docker
docker-compose up -d

# Or start manually
npm run dev              # Terminal 1: Backend
node server/workers/imageGeneration.js  # Terminal 2: Worker
```

### Test

```bash
curl http://localhost:3000/api/health
```

## 📚 Documentation

- [Setup Guide](./docs/SETUP.md) — Local & production setup
- [API Reference](./docs/API.md) — Complete API documentation

## 🔐 Environment Variables

See [.env.example](./.env.example) for all configuration options.

### Critical Variables

```env
JWT_SECRET=your_secret_key_change_in_production
DB_PASSWORD=your_database_password
STRIPE_SECRET_KEY=your_stripe_key
```

## 🚀 Deployment

### Docker

```bash
docker build -t zaire-sketch-mind .
docker run -p 3000:3000 --env-file .env zaire-sketch-mind
```

### Heroku

```bash
heroku create zaire-sketch-mind
git push heroku main
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Commit changes
4. Push to branch
5. Open a Pull Request

## 📄 License

MIT License — see [LICENSE](./LICENSE) file

## 👨‍💻 Author

Franklin Makana (@franklinmakana58-creator)

---

**Made with ❤️ by Franklin Makana**
