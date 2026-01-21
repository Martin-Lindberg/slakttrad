Steg 6B.7 – Fix: Träd syns inte efter skapande (API-shape kompatibilitet)

Symptom:
- POST /trees lyckas i Network men listan i UI uppdateras inte/visar inget.

Orsak (vanlig):
- Frontend och backend har olika fältnamn för träd-objekt (t.ex. treeId/treeName vs id/name).
- Då kan UI ignorera/filtrera bort svaret utan att kasta synligt fel.

Patch:
- Backend returnerar nu BOTH:
  - id + name (nuvarande)
  - treeId + treeName (alias för kompatibilitet)
- GET /trees, POST /trees, PUT /trees, DELETE /trees påverkas.

Gör så här:
1) Packa upp och skriv över:
   backend/src/index.ts
2) Commit + push:
   git add backend/src/index.ts
   git commit -m "6B.7: Return treeId/treeName aliases for frontend compatibility"
   git push
3) Render: Deploy latest commit
4) Testa i GitHub Pages: skapa släkt igen.
