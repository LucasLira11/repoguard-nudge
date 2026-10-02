# Desafio: painel de pedidos

Fixture **benigna com build** do RepoGuard-Nudge. Tem execução automática legítima (`prepare` e `preLaunchTask`) e um script de build que usa `child_process`, como muitos projetos reais.

Resultado esperado da análise: **pontuação 45 (execução automática 25 + comandos do sistema 20), nível BAIXO, nenhum alerta**. Serve para mostrar que sinais isolados, comuns em projetos legítimos, não disparam o painel.

Tarefa do candidato: adicione o campo `status` aos pedidos e rode `npm run build && npm start`.
