# Släktträd MVP – Steg 6A (GitHub Pages för frontend)

## Viktigt: Kan man köra backend på GitHub?
Nej – **GitHub Pages kan bara hosta statiska filer** (HTML/CSS/JS). Den kan inte köra en server (Node/Express, Postgres, osv).

GitHub kan däremot hjälpa till med backend på indirekta sätt (Actions som bygger, container registry, osv), men själva körningen måste ske någon annanstans.

I detta steg hostar vi **frontend** på GitHub Pages. Backend kör du lokalt tills vi gör **Steg 6B** (hostad backend på t.ex. Render/Fly.io/Railway).

---

## Vad som ingår
- Frontend får en konfigurerbar API-bas via `VITE_API_BASE`
- `vite.config.ts` använder `base: "./"` så att assets funkar i GitHub Pages oavsett repo-namn
- GitHub Actions workflow som bygger och deployar frontend till GitHub Pages

---

## Ändrade / nya filer
- NY: `slakttrad-mvp/frontend/vite.config.ts`
- NY: `slakttrad-mvp/frontend/.env.example`
- NY: `.github/workflows/deploy-frontend-pages.yml`
- PATCH: `slakttrad-mvp/frontend/src/ui/App.tsx` (API_BASE via `VITE_API_BASE`)

---

## Steg-för-steg (en gång)
1) Skapa ett GitHub-repo (t.ex. `slakttrad-mvp`) och pusha koden till `main`.
2) Gå till repo: **Settings → Pages**
3) Under **Build and deployment**:
   - Source: **GitHub Actions**
4) Gå till fliken **Actions** och kör / vänta på workflow: “Deploy Frontend to GitHub Pages”.
5) När den är klar får du en URL (står i Pages/Actions).

---

## Återkommande steg
- Varje push till `main` deployar automatiskt om sidan.

---

## Lokal utveckling (som tidigare)
Backend:
```bash
cd slakttrad-mvp/backend
npm run dev
```

Frontend:
```bash
cd slakttrad-mvp/frontend
npm run dev
```

---

## OBS: Frontend på Pages + backend lokalt
Workflow bygger med:
`VITE_API_BASE=http://localhost:4000`

Det betyder:
- Om **du** öppnar Pages-sidan på din dator och har backend igång lokalt → funkar.
- För andra användare → funkar inte, eftersom deras dator inte har din localhost-backend.

När du vill att andra ska kunna använda tjänsten går vi vidare med **Steg 6B: hosta backend** och sätter `VITE_API_BASE` till den publika backend-URL:en.
