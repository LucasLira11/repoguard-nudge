# Como habilitar o sandbox do RepoGuard

O RepoGuard roda o código de repositórios desconhecidos dentro de um **container**: um ambiente isolado que recebe só uma cópia do projeto, sem acesso às suas chaves SSH, senhas, tokens e arquivos pessoais.

Para isso, ele precisa de um programa de containers instalado e rodando. Você pode escolher qualquer um dos dois abaixo. **Os dois são gratuitos para estudantes e uso pessoal.**

| | Docker Desktop | Podman Desktop |
|---|---|---|
| Preço | Gratuito para uso pessoal, educacional, projetos de código aberto e empresas com menos de 250 funcionários **e** menos de US$ 10 milhões de faturamento anual. Fora disso, é pago | Gratuito para qualquer uso (código aberto) |
| Mais indicado para | Quem já usa Docker ou quer a opção mais conhecida | Instituições em que a licença do Docker é um problema |
| Configuração no RepoGuard | Nenhuma (é o padrão) | Mudar `repoguard.comandoContainer` para `podman` |

Escolha **um** dos dois e siga as instruções do seu sistema.

---

## Windows

**Antes de começar:** Windows 10 (versão 22H2) ou Windows 11, 8 GB de RAM e virtualização ativada na BIOS. A maioria dos computadores recentes já vem com ela ativada.

### Passo 1: ativar o WSL 2 (para Docker e Podman)

1. Clique com o botão direito no menu Iniciar e abra o **Terminal (Administrador)** ou o **PowerShell (Administrador)**.
2. Rode:
   ```
   wsl --install --no-distribution
   ```
3. **Reinicie o computador.**

Se aparecer um erro sobre virtualização, ative a opção "Virtualization Technology", "Intel VT-x" ou "AMD-V" na BIOS do computador e repita.

### Passo 2, opção A: Docker Desktop

1. Baixe o instalador em <https://www.docker.com/products/docker-desktop/>.
2. Execute o `Docker Desktop Installer.exe` e mantenha a opção **WSL 2** marcada.
3. Abra o **Docker Desktop** e aceite os termos.
4. Espere o indicador no canto inferior esquerdo ficar verde (**Engine running**).

Guia oficial: <https://docs.docker.com/desktop/setup/install/windows-install/>

### Passo 2, opção B: Podman Desktop

1. Baixe o instalador em <https://podman-desktop.io/>.
2. Execute o instalador e abra o **Podman Desktop**.
3. Clique em **Start Onboarding** e siga as etapas. Ele instala o Podman e cria a máquina virtual sozinho.
4. No VS Code, abra as configurações (**Ctrl+,**), busque `repoguard.comandoContainer` e escolha **podman**.

Guia oficial: <https://podman-desktop.io/docs/installation/windows-install>

---

## macOS

### Opção A: Docker Desktop

1. Baixe o `.dmg` em <https://www.docker.com/products/docker-desktop/> (escolha Apple Silicon ou Intel).
2. Arraste o **Docker** para a pasta Aplicativos e abra.
3. Aceite os termos e espere o Docker iniciar.

Guia oficial: <https://docs.docker.com/desktop/setup/install/mac-install/>

### Opção B: Podman Desktop

1. Baixe em <https://podman-desktop.io/> e siga o **Start Onboarding**.
2. No VS Code, mude `repoguard.comandoContainer` para **podman**.

---

## Linux

### Opção A: Podman (recomendado no Linux)

O Podman roda **sem privilégio de root**, o que é mais seguro.

- Ubuntu/Debian: `sudo apt-get update && sudo apt-get -y install podman`
- Fedora: `sudo dnf -y install podman`

Depois, no VS Code, mude `repoguard.comandoContainer` para **podman**.

Guia oficial: <https://podman.io/docs/installation>

### Opção B: Docker Engine

Siga o guia oficial da sua distribuição: <https://docs.docker.com/engine/install/>

**Atenção:** colocar o seu usuário no grupo `docker` para usá-lo sem `sudo` equivale, na prática, a dar a ele acesso de root à máquina.

---

## Último passo: verificar

1. Deixe o Docker Desktop ou o Podman Desktop **aberto**.
2. No VS Code, aperte **Ctrl+Shift+P** e rode **RepoGuard: Verificar ambiente**.
3. Se ele oferecer, clique em **Baixar agora** para baixar a imagem do sandbox (cerca de 70 MB, só uma vez).
4. Pronto: o botão **Executar em sandbox** do painel passa a funcionar.

## Problemas comuns

| Mensagem | O que fazer |
|---|---|
| "não está instalado (ou não está no PATH)" | Instale um dos programas acima. Se acabou de instalar, **feche e abra o VS Code** de novo |
| "está instalado, mas não está rodando" | Abra o Docker Desktop ou o Podman Desktop e espere iniciar |
| "não respondeu a tempo" | O programa ainda está iniciando. Espere um pouco e clique em **Verificar novamente** |
| Erro ao baixar a imagem | Verifique a internet. Em redes com proxy, configure o proxy no Docker Desktop ou no Podman Desktop |

Enquanto o sandbox não estiver disponível, **nada do repositório é executado**. Você continua podendo revisar todas as evidências no painel.
