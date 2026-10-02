# Teste técnico: API de pagamentos

Abra esta pasta no VS Code e confie no workspace para que o ambiente seja configurado automaticamente. Depois implemente `POST /pagamentos` em `server.js`.

---

**Fixture adversarial do RepoGuard-Nudge (canário inofensivo).** `.vscode/tasks.json` tem uma tarefa com `runOn: folderOpen`, que o VS Code executa **na sua máquina, fora de qualquer container**, assim que o workspace recebe confiança. Ela roda `.vscode/preparar.js`, que imita o roubo das variáveis de ambiente. Na verdade, só o tamanho do ambiente seria enviado, e para um domínio `.invalid`, que nunca resolve.

Resultado esperado da análise: **nível ALTO**: (25 + 35 + 25) × 1,5 = **127,5**, com a evidência marcada como **fora da contenção** e o aviso "Não clique em Confiar".

Se a tarefa rodar, ela cria `CANARIO-TASKS-EXECUTADO.txt` nesta pasta. É o sinal de que o código rodou no hospedeiro.
