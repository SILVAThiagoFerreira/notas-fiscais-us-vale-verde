# Notas Fiscais · US Vale Verde

Dashboard interativo das **Notas Fiscais de transporte/frete** da operação —
séries temporais de valor do frete, valor total das NFs, quantidade transportada
e número de notas, com recortes por **produto** e por **origem**, KPIs financeiros
e tabela detalhada com busca, ordenação e paginação.

## Online
https://silvathiagoferreira.github.io/notas-fiscais-us-vale-verde/

## Como funciona
- Site estático (HTML/CSS/JS + Chart.js via CDN), hospedado no GitHub Pages.
- Lê em tempo real a planilha de Notas Fiscais da US Vale Verde (Google Sheets,
  API gviz) — atualiza a cada acesso, sem servidor nem build.
- Mesma linguagem visual dos demais dashboards do hub (#38424B + #E20613, cards brancos).

## Fonte de dados
Google Sheet de Notas Fiscais da US Vale Verde (357 NFs, jul/2024–jun/2026).
Rotas: Escada-PE e Quatro Barras-PR → Craíbas-AL. Produtos: emulsão e acessórios
de desmonte (boosters, cordéis detonantes, etc.).

Parte do hub de dashboards da US Vale Verde.
