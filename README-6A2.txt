Steg 6A.2 – Fix: GitHub Actions build fail (JSX-div saknar stängning)

Vad detta fixar:
- App.tsx hade en fel-nestning i "Mina släkter"-headern som gjorde att ett <div> aldrig stängdes.
- Workflow är uppdaterat till korrekt working-directory för din struktur (repo-root har frontend/ direkt).

Gör så här:
1) Packa upp zip och skriv över:
   - frontend/src/ui/App.tsx
   - .github/workflows/deploy-frontend-pages.yml

2) Commit + push:
   git add .
   git commit -m "Fix TSX build + update Pages workflow"
   git push

3) Gå till GitHub → Actions och kör workflowet igen (eller vänta på att push triggar).
