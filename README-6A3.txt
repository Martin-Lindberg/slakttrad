Steg 6A.3 – Fix: TypeScript-build i GitHub Actions

Varför:
- Din App.tsx har blivit korrupt (t.ex. av "..." / felaktiga setter-namn), vilket gör att TypeScript-builden failar i GitHub Actions.
- Detta zip återställer App.tsx till en fungerande version (baserad på senaste fungerande steg) + gör API-bas konfigurerbar via VITE_API_BASE.
- Workflow uppdateras så att den matchar din riktiga repo-struktur: repo-root innehåller frontend/ direkt.

Gör så här:
1) Packa upp och skriv över filerna i ditt repo:
   - frontend/src/ui/App.tsx
   - .github/workflows/deploy-frontend-pages.yml
   - frontend/vite.config.ts  (om den saknas)

2) Commit + push:
   git add .
   git commit -m "Fix TS build + correct Pages workflow paths"
   git push

3) GitHub → Actions: kör workflow igen.

Återkommande:
- Varje push till main deployar om.
