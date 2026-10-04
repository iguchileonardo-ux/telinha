# Telinha

App de desktop para a sua turma de amigos: chat, call de voz, compartilhamento de tela, reações, ponteiro, desenho na tela e rádio. Tudo direto entre os computadores, sem VPN e sem código de pareamento: só um convite.

## Como abrir

**Só na primeira vez:** dê dois cliques em `Criar instalador.bat`. Ele prepara tudo sozinho, instala a Telinha e coloca uma cópia do instalador em `Documentos\Telinha Instalador`.

**Depois disso:** abra pelo atalho **Telinha**, na Área de Trabalho ou no Menu Iniciar.

**Para mandar aos amigos:** o atalho **Telinha Instalador**, na Área de Trabalho, abre a pasta com o `Telinha-Instalador.exe`. Arraste o arquivo para uma conversa do WhatsApp (ele passa do limite de tamanho do Discord). Como o instalador não é assinado digitalmente, o Windows pode mostrar um aviso do SmartScreen. Nesse caso, clique em "Mais informações" e depois em "Executar assim mesmo".

## Turmas

Uma **Turma** é como um servidor do Discord: fica salva na barra da esquerda e guarda membros e histórico.

- **Criar:** botão **+** → **Criar turma**. O convite (`telinha://sala/xxxx-xxxx-xxxx`) é copiado automaticamente.
- **Entrar:** copie o convite e abra a Telinha. Aparece **Convite copiado → Entrar**. Também dá para colar o convite no **+**.
- **Renomear, copiar convite ou sair:** clique com o botão direito no ícone da turma, ou clique no nome dela no topo.
- **Membros:** os avatares no topo mostram quem está online, na call ou transmitindo, e quem já participou.

### Chat

- **Histórico:** as mensagens ficam salvas no computador de cada membro. Quem entra depois recebe o histórico de quem estiver online.
- **Fixar:** passe o mouse sobre uma mensagem e clique no alfinete para fixá-la no topo.
- **Links:** ficam clicáveis.
- **Rádio pelo chat:** `/tocar <link do YouTube>` coloca a música no rádio da turma.

### Call

- **Entrar:** **Entrar na call** (ou **sem microfone**).
- **Microfone:** a tecla **M** liga e desliga.
- **Volume por pessoa:** no menu de membros.
- **Quem está falando** ganha um contorno verde.
- **Compartilhar** abre o seletor:
  - **Telas** e **Janelas**: jogos abertos aparecem primeiro, marcados como "Jogo", e a última fonte usada vem selecionada.
  - **Só som**: compartilha só o áudio de um programa (Spotify, por exemplo) ou do PC inteiro, sem imagem.
- **Reações:** no botão de carinha. Cada membro pode adicionar imagens (PNG, JPG, WebP ou GIF) à galeria da turma. As teclas **1** a **9** são atalhos.
- **Ponteiro:** passe o mouse sobre a tela de alguém e clique na seta. Todos veem um ponto com o seu nome, inclusive quem transmite, por cima da tela dele.
- **Desenho:** clique no lápis para **pedir permissão**. Quem transmite aceita ou recusa e pode retirar a permissão quando quiser. Os traços somem sozinhos depois de alguns segundos e não entram no vídeo.

### Rádio

O botão de nota musical abre o rádio da turma:

- **Pedir música:** cole um link do YouTube. A fila toca sincronizada para todos na call.
- **Como toca:** cada computador toca a música com o player oficial do YouTube, sem baixar nada. A Telinha só mantém todo mundo no mesmo ponto. Podem aparecer anúncios do próprio YouTube.
- **Controles:** pausar, pular e remover itens da fila.
- **Volume:** o rádio tem volume próprio e abaixa sozinho quando alguém fala.

### Áudio sem eco (Windows 10 2004 ou mais novo)

- **Janela:** envia só o som do programa escolhido.
- **Tela inteira:** envia o som do PC **exceto** o da Telinha. Assim, as vozes da call e o rádio não voltam para os outros.

## Qualidade

Em **Configurações → Qualidade da transmissão**:

| Opção | Quadros | Para quê |
| --- | --- | --- |
| **Nitidez** | 30 | texto, código, navegação |
| **Fluidez** | 60 | jogos |
| **Filme** | 24 | filmes: som estéreo de alta qualidade e um buffer maior para não travar |

A qualidade se adapta à internet de cada um: se a conexão piorar, a resolução cai antes de a imagem travar. Quem transmite envia uma cópia para cada pessoa, então o upload é o limite.

## Aparência

**Configurações → Tema:** Escuro, Claro ou Sistema. Lá também ficam a **foto de perfil** e o nome.

## Microfone e saída de áudio

**Configurações → Áudio:** escolha o microfone e onde ouvir a call, as telas e o rádio (fone, caixa de som). A troca do microfone vale na hora, mesmo no meio da call. Se o dispositivo escolhido for desconectado, a Telinha usa o padrão do sistema.

## Atualização automática

A Telinha busca versões novas nas Releases do repositório `telinha` no seu GitHub.

- **Primeira vez:** dois cliques em `Configurar GitHub.bat`. Ele instala o Git e o GitHub CLI, faz o login pelo navegador, cria o repositório e publica a versão atual. O login e a identidade do Git ficam valendo para outros projetos.
- **Versões novas:** aumente `"version"` no `package.json` e dê dois cliques em `Publicar atualizacao.bat`.

Quem tem a Telinha instalada baixa a versão nova em segundo plano, e ela é aplicada quando o app reinicia. Instaladores gerados antes dessa configuração não se atualizam: quem tiver um deles precisa reinstalar uma vez.

## Rodando a partir do código

```bash
npm install
npm start          # abre a Telinha
npm run segunda    # segunda instância independente, para testar sozinho
npm run dist       # gera o instalador em release/
npm run servidor   # servidor de sinalização opcional (porta 8080)
```

Sem Node instalado, o `testar.bat` baixa uma versão portátil e abre duas instâncias.

## Conexão

O vídeo e a voz vão direto de um computador para o outro (WebRTC, criptografado de ponta a ponta). Para se encontrarem, a Telinha usa, nesta ordem:

| Caminho | Quando |
| --- | --- |
| **Servidor da Telinha** (pasta `servidor-cloudflare/`) | Padrão. Roda de graça no Cloudflare. |
| **Relays públicos Nostr** | Reserva automática, se o servidor não responder em 12 segundos. |
| **Servidor escolhido** | Configurações → Conexão → Servidor próprio. |

Quando duas redes não aceitam conexão direta (CGNAT, 4G, redes corporativas), a Telinha usa:

- **TURN do Cloudflare:** repassa o tráfego dessas duas pessoas. As credenciais são temporárias e as chaves ficam só no servidor.
- **Ponte:** se o TURN não estiver disponível, alguém da turma conectado às duas pessoas repassa chat, voz e telas.

**Para colocar o servidor no ar:** dois cliques em `Configurar servidor.bat`. Ele faz o login no Cloudflare pelo navegador, publica o servidor, grava o endereço no `package.json` e, se você quiser, configura o TURN. Depois, rode `Publicar atualizacao.bat`.

### Quedas e diagnóstico na call

- **Queda de conexão:** se alguém cai sem sair (Wi-Fi, hibernação), a Telinha tenta reconectar sozinha por até 10 minutos, sem derrubar os outros.
- **Fone desconectado:** o microfone muda para o padrão do sistema e volta para o escolhido quando o fone é religado. O mesmo vale para a saída de áudio.
- **Qualidade da conexão:** passe o mouse sobre uma pessoa na call para ver o atraso, a perda e o caminho (direto, TURN ou ponte). Um ponto amarelo ou vermelho aparece quando a conexão está instável ou ruim.
- **Microfone:** em Configurações, a barrinha embaixo do microfone mostra se ele está captando. Se você falar com o microfone desligado, a Telinha avisa.

## Limitações conhecidas

- Todos da turma precisam estar na versão 2 para usar chat, call e o resto.
- **Captura de áudio, ponteiro na tela de quem transmite e detecção de jogos:** só funcionam no Windows.
- **Áudio de janela:** pega o processo dono da janela e os filhos dele. Programas que tocam som por outro processo podem ficar mudos. Nesse caso, use o áudio do computador.
- **Sem servidor:** o histórico só chega a quem entra depois se alguém que já tem as mensagens estiver online.
- **Turmas grandes**, com muitos espectadores, exigiriam um servidor que repasse o vídeo (SFU).

## Estrutura

```
app/
  main.js            processo principal (janela, captura, links, atualização)
  audio.js           áudio sem eco (WASAPI process loopback)
  native.js          funções do Windows (janela → processo, posição, jogos)
  overlay.js         camada de ponteiro/desenho sobre a tela compartilhada
  radio.js           player do YouTube escondido do rádio
  preload.js         ponte segura com a interface
  renderer/
    index.html, style.css, overlay.html
    src/
      main.js        fluxo do app (turmas, abas, configurações)
      turma.js       rede: presença, chat, imagens, call, telas, ponteiro, desenho, rádio
      store.js       dados locais (IndexedDB)
      capture.js     seletor e captura (tela, janela, só som)
      stage.js       grade de telas com ponteiro e desenho
      annotate.js    desenho dos ponteiros e traços
      ui/            chat, call, membros, reações, rádio
server/server.mjs    servidor de sinalização opcional
```
