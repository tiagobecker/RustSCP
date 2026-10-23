/**
 * What the terminal assistant knows about Linux commands: plain-language explanations of
 * commands and their options, ready-made commands for common admin tasks, warnings for
 * destructive commands and hints for the usual error messages. Pure data and functions,
 * no UI.
 */

type L = [pt: string, en: string];
const pick = (l: L, isPt: boolean) => (isPt ? l[0] : l[1]);

// ---------------------------------------------------------------------------
// Commands and options
// ---------------------------------------------------------------------------

interface CommandInfo {
  what: L;
  flags?: Record<string, L>;
  /** Usually needs administrator rights. */
  root?: boolean;
}

const COMMANDS: Record<string, CommandInfo> = {
  ls: {
    what: ['lista os arquivos e pastas', 'lists files and folders'],
    flags: {
      '-l': ['detalhes: permissões, dono, tamanho e data', 'details: permissions, owner, size and date'],
      '-a': ['inclui arquivos ocultos (que começam com .)', 'includes hidden files (starting with .)'],
      '-h': ['tamanhos legíveis (K, M, G)', 'human-readable sizes (K, M, G)'],
      '-t': ['ordena pelos mais recentes', 'sorts by newest first'],
      '-r': ['inverte a ordem', 'reverses the order'],
      '-S': ['ordena por tamanho', 'sorts by size'],
      '-R': ['entra nas subpastas', 'goes into subfolders'],
    },
  },
  cd: { what: ['entra em uma pasta (cd .. sobe um nível, cd ~ vai para a sua pasta)', 'changes folder (cd .. goes up, cd ~ goes home)'] },
  pwd: { what: ['mostra em qual pasta você está', 'shows which folder you are in'] },
  cat: { what: ['mostra o conteúdo de um arquivo', "prints a file's contents"], flags: { '-n': ['numera as linhas', 'numbers the lines'] } },
  less: { what: ['abre um arquivo para ler com rolagem (q sai, / busca)', 'opens a file to scroll through (q quits, / searches)'] },
  more: { what: ['mostra um arquivo página por página', 'shows a file page by page'] },
  head: { what: ['mostra o começo de um arquivo', 'shows the start of a file'], flags: { '-n': ['quantas linhas mostrar', 'how many lines to show'] } },
  tail: {
    what: ['mostra o final de um arquivo', 'shows the end of a file'],
    flags: {
      '-n': ['quantas linhas mostrar', 'how many lines to show'],
      '-f': ['continua mostrando o que for escrito (Ctrl+C para parar)', 'keeps showing new lines (Ctrl+C to stop)'],
      '-F': ['como -f, e acompanha o arquivo se ele for trocado', 'like -f, following the file if it is replaced'],
    },
  },
  grep: {
    what: ['procura um texto dentro de arquivos ou de uma saída', 'searches for text in files or output'],
    flags: {
      '-i': ['ignora maiúsculas/minúsculas', 'ignores case'],
      '-r': ['procura em todas as subpastas', 'searches all subfolders'],
      '-R': ['procura em todas as subpastas', 'searches all subfolders'],
      '-n': ['mostra o número da linha', 'shows line numbers'],
      '-v': ['mostra as linhas que NÃO contêm o texto', 'shows lines that do NOT match'],
      '-c': ['só conta as linhas encontradas', 'only counts matching lines'],
      '-l': ['só lista os arquivos que contêm o texto', 'only lists files that match'],
      '-E': ['usa expressões regulares estendidas', 'uses extended regular expressions'],
      '-w': ['só palavras inteiras', 'whole words only'],
    },
  },
  find: {
    what: ['procura arquivos e pastas', 'finds files and folders'],
    flags: {
      '-name': ['pelo nome (aceita * e ?)', 'by name (accepts * and ?)'],
      '-iname': ['pelo nome, ignorando maiúsculas', 'by name, ignoring case'],
      '-type': ['pelo tipo: f arquivo, d pasta', 'by type: f file, d folder'],
      '-size': ['pelo tamanho (+100M = maior que 100 MB)', 'by size (+100M = over 100 MB)'],
      '-mtime': ['pela data de alteração em dias', 'by modification age in days'],
      '-delete': ['APAGA o que encontrar', 'DELETES what it finds'],
      '-exec': ['roda um comando para cada resultado', 'runs a command on each result'],
    },
  },
  cp: {
    what: ['copia arquivos', 'copies files'],
    flags: {
      '-r': ['copia pastas inteiras', 'copies whole folders'],
      '-R': ['copia pastas inteiras', 'copies whole folders'],
      '-a': ['copia tudo mantendo permissões e datas', 'copies everything, keeping permissions and dates'],
      '-i': ['pergunta antes de substituir', 'asks before overwriting'],
      '-v': ['mostra cada arquivo copiado', 'shows each file copied'],
    },
  },
  mv: { what: ['move ou renomeia arquivos', 'moves or renames files'], flags: { '-i': ['pergunta antes de substituir', 'asks before overwriting'], '-v': ['mostra cada arquivo', 'shows each file'] } },
  rm: {
    what: ['APAGA arquivos (não há lixeira)', 'DELETES files (there is no trash)'],
    flags: {
      '-r': ['apaga pastas e tudo dentro delas', 'deletes folders and everything inside'],
      '-R': ['apaga pastas e tudo dentro delas', 'deletes folders and everything inside'],
      '-f': ['não pergunta nada, nem avisa erros', 'never asks, ignores errors'],
      '-i': ['pergunta antes de cada arquivo', 'asks before each file'],
      '-v': ['mostra cada arquivo apagado', 'shows each deleted file'],
    },
  },
  mkdir: { what: ['cria uma pasta', 'creates a folder'], flags: { '-p': ['cria também as pastas do caminho, sem erro se existir', 'creates parent folders too, no error if it exists'] } },
  rmdir: { what: ['apaga uma pasta vazia', 'deletes an empty folder'] },
  touch: { what: ['cria um arquivo vazio (ou atualiza a data)', 'creates an empty file (or updates its date)'] },
  ln: { what: ['cria um link para um arquivo', 'creates a link to a file'], flags: { '-s': ['link simbólico (atalho)', 'symbolic link (shortcut)'] } },
  chmod: {
    what: ['muda as permissões de arquivos', 'changes file permissions'],
    flags: { '-R': ['em todas as subpastas também', 'in all subfolders too'], '+x': ['torna executável', 'makes it executable'] },
  },
  chown: { what: ['muda o dono de arquivos', 'changes who owns files'], root: true, flags: { '-R': ['em todas as subpastas também', 'in all subfolders too'] } },
  du: {
    what: ['mostra quanto espaço pastas e arquivos ocupam', 'shows how much space folders and files use'],
    flags: {
      '-h': ['tamanhos legíveis', 'human-readable sizes'],
      '-s': ['só o total de cada item', 'only the total of each item'],
      '-a': ['inclui os arquivos, não só pastas', 'includes files, not only folders'],
      '--max-depth=1': ['só um nível de subpastas', 'only one level of subfolders'],
      '-d': ['profundidade das subpastas', 'subfolder depth'],
    },
  },
  df: {
    what: ['mostra o espaço livre nos discos', 'shows free disk space'],
    flags: { '-h': ['tamanhos legíveis (K, M, G)', 'human-readable sizes (K, M, G)'], '-i': ['mostra inodes (quantidade de arquivos)', 'shows inodes (number of files)'], '-T': ['mostra o tipo do sistema de arquivos', 'shows the file system type'] },
  },
  free: { what: ['mostra a memória RAM usada e livre', 'shows used and free memory'], flags: { '-h': ['tamanhos legíveis', 'human-readable sizes'], '-m': ['em megabytes', 'in megabytes'] } },
  top: { what: ['mostra os processos que mais usam CPU e memória, ao vivo (q sai)', 'live view of the busiest processes (q quits)'] },
  htop: { what: ['versão mais amigável do top (F10 sai)', 'friendlier version of top (F10 quits)'] },
  ps: {
    what: ['lista os processos em execução', 'lists running processes'],
    flags: { aux: ['todos os processos, com usuário, CPU e memória', 'all processes with user, CPU and memory'], '-ef': ['todos os processos, formato completo', 'all processes, full format'] },
  },
  kill: { what: ['envia um sinal para um processo (normalmente para encerrá-lo)', 'sends a signal to a process (usually to stop it)'], flags: { '-9': ['força o encerramento imediato', 'forces it to stop right away'], '-15': ['pede para encerrar (padrão)', 'asks it to stop (default)'] } },
  pkill: { what: ['encerra processos pelo nome', 'stops processes by name'] },
  killall: { what: ['encerra todos os processos com esse nome', 'stops every process with that name'] },
  uptime: { what: ['mostra há quanto tempo o servidor está ligado e a carga', 'shows how long the server has been up and its load'] },
  uname: { what: ['mostra informações do sistema e do kernel', 'shows system and kernel information'], flags: { '-a': ['todas as informações', 'all information'], '-r': ['versão do kernel', 'kernel version'] } },
  hostname: { what: ['mostra o nome do servidor', "shows the server's name"], flags: { '-I': ['mostra os endereços IP', 'shows the IP addresses'] } },
  whoami: { what: ['mostra com qual usuário você está logado', 'shows which user you are'] },
  who: { what: ['mostra quem está conectado', 'shows who is logged in'] },
  w: { what: ['mostra quem está conectado e o que está fazendo', 'shows who is logged in and what they do'] },
  id: { what: ['mostra seu usuário e grupos', 'shows your user and groups'] },
  last: { what: ['mostra os últimos logins', 'shows recent logins'] },
  history: { what: ['mostra os comandos que você digitou neste servidor', 'shows the commands you typed on this server'] },
  clear: { what: ['limpa a tela', 'clears the screen'] },
  echo: { what: ['escreve um texto na tela', 'prints text'] },
  date: { what: ['mostra a data e a hora do servidor', "shows the server's date and time"] },
  cal: { what: ['mostra um calendário', 'shows a calendar'] },
  sudo: { what: ['roda o comando seguinte como administrador (pede a sua senha)', 'runs the next command as administrator (asks your password)'], flags: { '-i': ['abre um shell de administrador', 'opens an administrator shell'], '-u': ['como outro usuário', 'as another user'] } },
  su: { what: ['troca para outro usuário (sem nome: root)', 'switches to another user (none: root)'] },
  passwd: { what: ['troca a senha', 'changes a password'] },
  useradd: { what: ['cria um usuário', 'creates a user'], root: true },
  adduser: { what: ['cria um usuário (de forma interativa)', 'creates a user (interactive)'], root: true },
  userdel: { what: ['apaga um usuário', 'deletes a user'], root: true, flags: { '-r': ['apaga também a pasta pessoal dele', 'also deletes their home folder'] } },
  usermod: { what: ['altera um usuário', 'changes a user'], root: true, flags: { '-aG': ['adiciona a um grupo (sem tirar dos outros)', 'adds to a group (keeping the others)'] } },
  groups: { what: ['mostra os grupos de um usuário', "shows a user's groups"] },
  systemctl: {
    what: ['controla os serviços do sistema (systemd)', 'controls system services (systemd)'],
    flags: {
      status: ['mostra se o serviço está rodando e as últimas mensagens', 'shows whether the service runs and its latest messages'],
      start: ['inicia o serviço', 'starts the service'],
      stop: ['para o serviço', 'stops the service'],
      restart: ['reinicia o serviço', 'restarts the service'],
      reload: ['recarrega a configuração sem parar', 'reloads its configuration without stopping'],
      enable: ['inicia o serviço sempre que o servidor ligar', 'starts the service at every boot'],
      disable: ['não inicia mais o serviço ao ligar', 'no longer starts it at boot'],
      'list-units': ['lista serviços e outras unidades', 'lists services and other units'],
      '--failed': ['só os que falharam', 'only failed ones'],
      'is-active': ['responde se está rodando', 'answers whether it runs'],
    },
  },
  service: { what: ['controla serviços (forma antiga)', 'controls services (older way)'], root: true },
  journalctl: {
    what: ['mostra os registros (logs) do sistema', 'shows system logs'],
    flags: {
      '-u': ['só de um serviço', 'only one service'],
      '-f': ['continua mostrando o que chegar (Ctrl+C para parar)', 'keeps showing new entries (Ctrl+C to stop)'],
      '-n': ['quantas linhas', 'how many lines'],
      '-e': ['vai direto para o final', 'jumps to the end'],
      '-b': ['só desde que o servidor ligou', 'only since the last boot'],
      '-p': ['por prioridade (err = só erros)', 'by priority (err = errors only)'],
      '--since': ['a partir de quando (ex.: "1 hour ago")', 'starting when (e.g. "1 hour ago")'],
      '--no-pager': ['sem paginação', 'without a pager'],
    },
  },
  dmesg: { what: ['mostra mensagens do kernel (hardware, discos)', 'shows kernel messages (hardware, disks)'], flags: { '-T': ['com data legível', 'with readable timestamps'] } },
  ip: { what: ['mostra e configura a rede', 'shows and configures networking'], flags: { a: ['endereços de rede (IPs)', 'network addresses (IPs)'], addr: ['endereços de rede (IPs)', 'network addresses (IPs)'], r: ['rotas', 'routes'], route: ['rotas', 'routes'] } },
  ifconfig: { what: ['mostra as interfaces de rede (forma antiga)', 'shows network interfaces (older way)'] },
  ping: { what: ['testa se outro computador responde pela rede', 'tests whether another host answers'], flags: { '-c': ['quantas vezes (senão roda até Ctrl+C)', 'how many times (otherwise until Ctrl+C)'] } },
  curl: { what: ['acessa um endereço web e mostra a resposta', 'fetches a web address and prints the answer'], flags: { '-I': ['só os cabeçalhos', 'headers only'], '-L': ['segue redirecionamentos', 'follows redirects'], '-O': ['salva em arquivo', 'saves to a file'], '-s': ['silencioso', 'silent'], '-v': ['mostra detalhes da conexão', 'shows connection details'] } },
  wget: { what: ['baixa um arquivo da internet', 'downloads a file'] },
  ss: { what: ['mostra conexões e portas abertas', 'shows connections and open ports'], flags: { '-t': ['TCP', 'TCP'], '-u': ['UDP', 'UDP'], '-l': ['só portas esperando conexões', 'listening ports only'], '-n': ['números em vez de nomes', 'numbers instead of names'], '-p': ['mostra o programa de cada porta', 'shows the program of each port'], '-ltnp': ['portas TCP abertas e seus programas', 'open TCP ports and their programs'] } },
  netstat: { what: ['mostra conexões e portas (forma antiga)', 'shows connections and ports (older way)'] },
  dig: { what: ['consulta o DNS de um domínio', 'queries DNS for a domain'] },
  nslookup: { what: ['consulta o DNS de um domínio', 'queries DNS for a domain'] },
  traceroute: { what: ['mostra o caminho até outro computador', 'shows the network path to a host'] },
  ssh: { what: ['conecta em outro servidor', 'connects to another server'] },
  scp: { what: ['copia arquivos entre servidores', 'copies files between servers'] },
  rsync: { what: ['sincroniza pastas (copia só o que mudou)', 'syncs folders (copies only changes)'], flags: { '-a': ['mantém permissões e datas', 'keeps permissions and dates'], '-v': ['mostra os arquivos', 'shows the files'], '-z': ['comprime na transferência', 'compresses in transit'], '--delete': ['APAGA no destino o que não existe na origem', 'DELETES at the destination what is not in the source'], '-n': ['só simula', 'dry run'] } },
  tar: {
    what: ['junta ou extrai arquivos compactados (.tar, .tar.gz)', 'packs or extracts archives (.tar, .tar.gz)'],
    flags: {
      '-c': ['cria um arquivo', 'creates an archive'],
      '-x': ['extrai', 'extracts'],
      '-z': ['com compressão gzip (.gz)', 'with gzip (.gz)'],
      '-j': ['com compressão bzip2', 'with bzip2'],
      '-J': ['com compressão xz', 'with xz'],
      '-v': ['mostra cada arquivo', 'shows each file'],
      '-f': ['nome do arquivo (vem a seguir)', 'archive file name (follows)'],
      '-t': ['lista o conteúdo', 'lists the contents'],
      '-C': ['pasta de destino', 'destination folder'],
      '-czvf': ['cria um .tar.gz mostrando os arquivos', 'creates a .tar.gz, listing files'],
      '-xzvf': ['extrai um .tar.gz mostrando os arquivos', 'extracts a .tar.gz, listing files'],
    },
  },
  zip: { what: ['compacta em .zip', 'creates a .zip'], flags: { '-r': ['inclui as subpastas', 'includes subfolders'] } },
  unzip: { what: ['extrai um .zip', 'extracts a .zip'] },
  gzip: { what: ['compacta um arquivo (.gz)', 'compresses a file (.gz)'] },
  gunzip: { what: ['descompacta um .gz', 'decompresses a .gz'] },
  nano: { what: ['editor de texto simples (Ctrl+O salva, Ctrl+X sai)', 'simple text editor (Ctrl+O saves, Ctrl+X quits)'] },
  vi: { what: ['editor de texto (i escreve, Esc e depois :wq salva e sai, :q! sai sem salvar)', 'text editor (i inserts, Esc then :wq saves and quits, :q! quits without saving)'] },
  vim: { what: ['editor de texto (i escreve, Esc e depois :wq salva e sai, :q! sai sem salvar)', 'text editor (i inserts, Esc then :wq saves and quits, :q! quits without saving)'] },
  apt: {
    what: ['instala e atualiza programas (Debian/Ubuntu)', 'installs and updates software (Debian/Ubuntu)'],
    root: true,
    flags: {
      update: ['baixa a lista de versões disponíveis', 'downloads the list of available versions'],
      upgrade: ['atualiza os programas instalados', 'upgrades installed software'],
      install: ['instala um programa', 'installs software'],
      remove: ['remove um programa', 'removes software'],
      purge: ['remove um programa e sua configuração', 'removes software and its configuration'],
      autoremove: ['remove dependências que sobraram', 'removes leftover dependencies'],
      search: ['procura programas', 'searches for software'],
      '-y': ['responde "sim" automaticamente', 'answers "yes" automatically'],
    },
  },
  'apt-get': { what: ['instala e atualiza programas (Debian/Ubuntu)', 'installs and updates software (Debian/Ubuntu)'], root: true },
  dnf: {
    what: ['instala e atualiza programas (Oracle Linux, RHEL, Fedora, Rocky, Alma)', 'installs and updates software (Oracle Linux, RHEL, Fedora, Rocky, Alma)'],
    root: true,
    flags: { install: ['instala um programa', 'installs software'], upgrade: ['atualiza tudo', 'upgrades everything'], update: ['atualiza tudo', 'upgrades everything'], remove: ['remove um programa', 'removes software'], search: ['procura programas', 'searches for software'], '-y': ['responde "sim" automaticamente', 'answers "yes" automatically'] },
  },
  yum: { what: ['instala e atualiza programas (CentOS, RHEL antigos)', 'installs and updates software (older CentOS, RHEL)'], root: true },
  apk: { what: ['instala programas (Alpine)', 'installs software (Alpine)'], root: true },
  pacman: { what: ['instala programas (Arch)', 'installs software (Arch)'], root: true },
  zypper: { what: ['instala programas (openSUSE)', 'installs software (openSUSE)'], root: true },
  snap: { what: ['instala pacotes snap', 'installs snap packages'], root: true },
  docker: {
    what: ['gerencia contêineres Docker', 'manages Docker containers'],
    flags: {
      ps: ['lista os contêineres rodando (-a: todos)', 'lists running containers (-a: all)'],
      logs: ['mostra o log de um contêiner', "shows a container's log"],
      exec: ['roda um comando dentro de um contêiner', 'runs a command inside a container'],
      images: ['lista as imagens', 'lists images'],
      restart: ['reinicia um contêiner', 'restarts a container'],
      stop: ['para um contêiner', 'stops a container'],
      start: ['inicia um contêiner', 'starts a container'],
      compose: ['gerencia vários contêineres de um arquivo compose', 'manages services from a compose file'],
      stats: ['uso de CPU e memória ao vivo', 'live CPU and memory use'],
      '-f': ['continua mostrando (Ctrl+C para parar)', 'keeps following (Ctrl+C to stop)'],
      '-it': ['modo interativo', 'interactive mode'],
    },
  },
  crontab: { what: ['agenda comandos para rodar sozinhos', 'schedules commands to run automatically'], flags: { '-l': ['lista os agendamentos', 'lists the schedule'], '-e': ['edita os agendamentos', 'edits the schedule'] } },
  ufw: { what: ['firewall simples (Ubuntu)', 'simple firewall (Ubuntu)'], root: true, flags: { status: ['mostra as regras', 'shows the rules'], allow: ['libera uma porta', 'opens a port'], deny: ['bloqueia', 'blocks'] } },
  'firewall-cmd': { what: ['firewall (Oracle Linux, RHEL, CentOS)', 'firewall (Oracle Linux, RHEL, CentOS)'], root: true, flags: { '--list-all': ['mostra as regras', 'shows the rules'], '--add-port': ['libera uma porta', 'opens a port'], '--permanent': ['vale também depois de reiniciar', 'survives a reboot'], '--reload': ['aplica as regras permanentes', 'applies permanent rules'] } },
  iptables: { what: ['regras de firewall em baixo nível', 'low-level firewall rules'], root: true },
  shutdown: { what: ['desliga ou reinicia o servidor', 'shuts down or restarts the server'], root: true, flags: { '-r': ['reinicia', 'restarts'], '-h': ['desliga', 'halts'], now: ['agora', 'now'] } },
  reboot: { what: ['REINICIA o servidor', 'RESTARTS the server'], root: true },
  wc: { what: ['conta linhas, palavras e caracteres', 'counts lines, words and characters'], flags: { '-l': ['só as linhas', 'lines only'] } },
  sort: { what: ['ordena linhas', 'sorts lines'], flags: { '-n': ['como números', 'numerically'], '-h': ['entende tamanhos (K, M, G)', 'understands sizes (K, M, G)'], '-r': ['ordem decrescente', 'descending'] } },
  uniq: { what: ['remove linhas repetidas seguidas', 'removes repeated adjacent lines'], flags: { '-c': ['conta as repetições', 'counts repeats'] } },
  awk: { what: ['processa texto em colunas', 'processes text column by column'] },
  sed: { what: ['edita texto (substituições)', 'edits text (substitutions)'], flags: { '-i': ['altera o arquivo diretamente', 'edits the file in place'] } },
  cut: { what: ['recorta colunas de um texto', 'cuts columns out of text'] },
  xargs: { what: ['passa a saída como argumentos para outro comando', 'passes output as arguments to another command'] },
  tee: { what: ['mostra a saída e também grava em arquivo', 'prints output and writes it to a file'] },
  which: { what: ['mostra onde um programa está instalado', 'shows where a program is installed'] },
  man: { what: ['abre o manual de um comando (q sai)', "opens a command's manual (q quits)"] },
  watch: { what: ['repete um comando a cada 2 s (Ctrl+C para)', 'reruns a command every 2 s (Ctrl+C stops)'], flags: { '-n': ['intervalo em segundos', 'interval in seconds'] } },
  lsblk: { what: ['lista os discos e partições', 'lists disks and partitions'] },
  mount: { what: ['monta um disco em uma pasta (sem argumentos: lista)', 'mounts a disk on a folder (no arguments: lists)'] },
  umount: { what: ['desmonta um disco', 'unmounts a disk'], root: true },
  lscpu: { what: ['mostra detalhes do processador', 'shows CPU details'] },
  nproc: { what: ['mostra quantos núcleos de CPU há', 'shows the number of CPU cores'] },
  openssl: { what: ['ferramentas de criptografia e certificados', 'cryptography and certificate tools'] },
  certbot: { what: ['emite e renova certificados HTTPS (Let’s Encrypt)', 'issues and renews HTTPS certificates (Let’s Encrypt)'], root: true },
  nginx: { what: ['servidor web nginx', 'nginx web server'], flags: { '-t': ['testa a configuração sem aplicar', 'tests the configuration without applying'] } },
  git: { what: ['controle de versões', 'version control'] },
  exit: { what: ['sai deste terminal', 'leaves this terminal'] },
  logout: { what: ['sai deste terminal', 'leaves this terminal'] },
  env: { what: ['mostra as variáveis de ambiente', 'shows environment variables'] },
  export: { what: ['define uma variável de ambiente', 'sets an environment variable'] },
  source: { what: ['carrega um arquivo de comandos no shell atual', 'loads a command file into this shell'] },
  screen: { what: ['mantém sessões rodando mesmo se a conexão cair', 'keeps sessions running if the connection drops'] },
  tmux: { what: ['mantém sessões rodando mesmo se a conexão cair (Ctrl+B D sai sem fechar)', 'keeps sessions running if the connection drops (Ctrl+B D detaches)'] },
  nohup: { what: ['roda um comando que continua mesmo se você sair', 'runs a command that survives logout'] },
  timedatectl: { what: ['mostra e ajusta data, hora e fuso horário', 'shows and sets date, time and time zone'] },
  hostnamectl: { what: ['mostra e altera o nome do servidor', 'shows and sets the host name'] },
};

/** Explanation of one piece of a command line. */
export interface ExplainPart {
  token: string;
  text: string;
  root?: boolean;
}

/** Splits a command line into words, keeping quoted text together. */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
      continue;
    }
    if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has || cur) words.push(cur);
      cur = '';
      has = false;
      continue;
    }
    // Pipes and command separators are words of their own.
    if (c === '|' || c === ';' || c === '&') {
      if (has || cur) words.push(cur);
      let op = c;
      if ((c === '|' || c === '&') && line[i + 1] === c) op += line[++i];
      words.push(op);
      cur = '';
      has = false;
      continue;
    }
    cur += c;
    has = true;
  }
  if (has || cur) words.push(cur);
  return words;
}

const SEPARATORS: Record<string, L> = {
  '|': ['envia a saída para o próximo comando', 'sends the output to the next command'],
  '&&': ['roda o próximo só se este der certo', 'runs the next one only if this succeeds'],
  '||': ['roda o próximo só se este falhar', 'runs the next one only if this fails'],
  ';': ['depois roda o próximo', 'then runs the next one'],
  '&': ['roda em segundo plano', 'runs in the background'],
};

/** Plain-language explanation of a command line, piece by piece. */
export function explainCommand(line: string, isPt: boolean): ExplainPart[] {
  const parts: ExplainPart[] = [];
  let expectCommand = true;
  let current: CommandInfo | null = null;
  for (const word of shellWords(line.trim())) {
    if (SEPARATORS[word]) {
      parts.push({ token: word, text: pick(SEPARATORS[word], isPt) });
      expectCommand = true;
      current = null;
      continue;
    }
    if (word === '>' || word === '>>') {
      parts.push({ token: word, text: word === '>' ? (isPt ? 'grava a saída no arquivo (substitui)' : 'writes output to the file (replaces it)') : isPt ? 'acrescenta a saída ao final do arquivo' : 'appends output to the file' });
      continue;
    }
    if (expectCommand) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue; // VAR=value prefix
      const name = word.split('/').pop() || word;
      const info = COMMANDS[name];
      if (info) {
        parts.push({ token: name, text: pick(info.what, isPt), root: info.root });
      }
      current = info ?? null;
      // `sudo` and friends are followed by another command.
      expectCommand = name === 'sudo' || name === 'nohup' || name === 'time' || name === 'watch' || name === 'xargs';
      continue;
    }
    if (!current?.flags) continue;
    const flag = current.flags[word];
    if (flag) {
      parts.push({ token: word, text: pick(flag, isPt) });
      continue;
    }
    // Combined short options: -rf = -r -f
    if (/^-[A-Za-z]{2,}$/.test(word)) {
      for (const ch of word.slice(1)) {
        const f = current.flags[`-${ch}`];
        if (f) parts.push({ token: `-${ch}`, text: pick(f, isPt) });
      }
    }
  }
  // One explanation per token is enough (`-r` twice, etc.).
  const seen = new Set<string>();
  return parts.filter((p) => {
    const k = `${p.token}\u0000${p.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function isKnownCommand(name: string) {
  return Object.prototype.hasOwnProperty.call(COMMANDS, name);
}

// ---------------------------------------------------------------------------
// Dangerous commands
// ---------------------------------------------------------------------------

export interface DangerWarning {
  level: 'critical' | 'warning';
  text: string;
}

const DANGER_RULES: Array<{ re: RegExp; level: DangerWarning['level']; text: L }> = [
  {
    re: /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+)+(-\S+\s+)*(\/\*?|\/\s|~\/?\*?|\*|\.\/?\*?|\$HOME\/?\*?)(\s|$)/,
    level: 'critical',
    text: ['Isto apaga a pasta inteira (ou o sistema todo) sem volta. Confira o caminho com muito cuidado.', 'This deletes a whole folder (or the entire system) for good. Check the path very carefully.'],
  },
  { re: /\bmkfs(\.\w+)?\b|\bwipefs\b/, level: 'critical', text: ['Isto formata um disco: tudo o que há nele será apagado.', 'This formats a disk: everything on it is erased.'] },
  { re: /\bdd\b[^|;&]*\bof=\/dev\//, level: 'critical', text: ['Isto escreve direto em um disco e pode destruir os dados dele.', 'This writes straight to a disk and can destroy its data.'] },
  { re: />\s*\/dev\/(sd|nvme|vd|xvd|hd)/, level: 'critical', text: ['Isto escreve direto em um disco e pode destruir os dados dele.', 'This writes straight to a disk and can destroy its data.'] },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, level: 'critical', text: ['Isto trava o servidor criando processos sem parar.', 'This freezes the server by spawning processes endlessly.'] },
  { re: /\bchmod\s+(-\S*R\S*\s+)\S*\s+\/(\s|$)|\bchown\s+(-\S*R\S*\s+)\S*\s+\/(\s|$)/, level: 'critical', text: ['Isto muda permissões do sistema inteiro e pode impedir o servidor de funcionar (inclusive o SSH).', 'This changes permissions of the whole system and can break the server (SSH included).'] },
  { re: /\bchmod\s+(-\S*R\S*\s+)?0?777\b/, level: 'warning', text: ['Permissão 777 deixa qualquer usuário alterar esses arquivos. Raramente é a solução certa.', 'Mode 777 lets any user change these files. It is rarely the right fix.'] },
  { re: /\b(shutdown|poweroff|halt)\b|\breboot\b|\binit\s+[06]\b|\bsystemctl\s+(reboot|poweroff|halt)\b/, level: 'warning', text: ['Isto desliga ou reinicia o servidor: a conexão vai cair e serviços ficam fora do ar.', 'This shuts down or restarts the server: the connection drops and services go offline.'] },
  { re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, level: 'warning', text: ['Isto roda um script baixado da internet sem você ver o que ele faz.', 'This runs a script from the internet without you seeing what it does.'] },
  { re: /\biptables\s+(-F|--flush)\b|\bufw\s+(disable|reset)\b|\bnft\s+flush\b/, level: 'warning', text: ['Isto muda o firewall e pode bloquear (ou expor) o acesso ao servidor.', 'This changes the firewall and can lock you out (or expose the server).'] },
  { re: /\bsystemctl\s+(stop|disable|mask)\s+(sshd?|ssh\.service|sshd\.service)\b/, level: 'critical', text: ['Isto para o SSH: você pode perder o acesso a este servidor.', 'This stops SSH: you may lose access to this server.'] },
  { re: /\brm\s+(-\S*\s+)*-[a-zA-Z]*[rR]/, level: 'warning', text: ['Isto apaga pastas e tudo dentro delas, sem lixeira.', 'This deletes folders and everything in them, with no trash.'] },
  { re: /\bfind\b.*\s-delete\b/, level: 'warning', text: ['Isto apaga tudo o que o find encontrar. Rode antes sem -delete para conferir a lista.', 'This deletes everything find matches. Run it without -delete first to check the list.'] },
  { re: /\brsync\b.*\s--delete\b/, level: 'warning', text: ['--delete apaga no destino o que não existe na origem.', '--delete removes at the destination what is not in the source.'] },
  { re: /\buserdel\b/, level: 'warning', text: ['Isto apaga um usuário do servidor.', 'This deletes a user account.'] },
  { re: /\b(apt|apt-get|dnf|yum)\s+(remove|purge|erase)\b/, level: 'warning', text: ['Isto remove programas; confira se nada importante depende deles.', 'This removes software; check that nothing important depends on it.'] },
  { re: /\bkill\s+-9\s+1\b/, level: 'critical', text: ['Isto derruba o sistema inteiro.', 'This brings the whole system down.'] },
  { re: /\bhistory\s+-c\b/, level: 'warning', text: ['Isto apaga o histórico de comandos do servidor (o histórico do RustSCP continua).', "This clears the server's command history (RustSCP's history stays)."] },
];

/** The most serious warning for a command line, if it is dangerous. */
export function dangerOf(line: string, isPt: boolean): DangerWarning | null {
  let found: DangerWarning | null = null;
  for (const rule of DANGER_RULES) {
    if (rule.re.test(line)) {
      const w = { level: rule.level, text: pick(rule.text, isPt) };
      if (rule.level === 'critical') return w;
      found = found ?? w;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Ready-made commands
// ---------------------------------------------------------------------------

export type CategoryId = 'system' | 'disk' | 'files' | 'network' | 'services' | 'logs' | 'packages' | 'users' | 'docker';

export const CATEGORIES: Array<{ id: CategoryId; label: L }> = [
  { id: 'system', label: ['Sistema e desempenho', 'System & performance'] },
  { id: 'disk', label: ['Disco e espaço', 'Disk & space'] },
  { id: 'files', label: ['Arquivos e pastas', 'Files & folders'] },
  { id: 'network', label: ['Rede e portas', 'Network & ports'] },
  { id: 'services', label: ['Serviços', 'Services'] },
  { id: 'logs', label: ['Logs e erros', 'Logs & errors'] },
  { id: 'packages', label: ['Programas e atualizações', 'Software & updates'] },
  { id: 'users', label: ['Usuários e acesso', 'Users & access'] },
  { id: 'docker', label: ['Docker', 'Docker'] },
];

export interface Snippet {
  id: string;
  category: CategoryId;
  title: L;
  /** The command; `<…>` marks a part to fill in. */
  command: string | ((pm: PackageManager) => string);
  keywords: string;
}

export type PackageManager = 'apt' | 'dnf' | 'yum' | 'apk' | 'pacman' | 'zypper' | 'brew' | 'unknown';

export function normalizePackageManager(raw?: string | null): PackageManager {
  switch ((raw || '').trim()) {
    case 'apt':
    case 'apt-get':
      return 'apt';
    case 'dnf':
    case 'yum':
    case 'apk':
    case 'pacman':
    case 'zypper':
    case 'brew':
      return raw!.trim() as PackageManager;
    default:
      return 'unknown';
  }
}

const pmCommand = (pm: PackageManager, action: 'refresh' | 'upgrade' | 'install' | 'remove' | 'search' | 'list', pkg = '<programa>'): string => {
  switch (pm) {
    case 'apt':
      return {
        refresh: 'sudo apt update',
        upgrade: 'sudo apt update && sudo apt upgrade',
        install: `sudo apt install ${pkg}`,
        remove: `sudo apt remove ${pkg}`,
        search: `apt search ${pkg}`,
        list: 'apt list --upgradable',
      }[action];
    case 'dnf':
    case 'yum':
      return {
        refresh: `sudo ${pm} makecache`,
        upgrade: `sudo ${pm} upgrade`,
        install: `sudo ${pm} install ${pkg}`,
        remove: `sudo ${pm} remove ${pkg}`,
        search: `${pm} search ${pkg}`,
        list: `${pm} check-update`,
      }[action];
    case 'apk':
      return { refresh: 'sudo apk update', upgrade: 'sudo apk upgrade', install: `sudo apk add ${pkg}`, remove: `sudo apk del ${pkg}`, search: `apk search ${pkg}`, list: 'apk version -l "<"' }[action];
    case 'pacman':
      return { refresh: 'sudo pacman -Sy', upgrade: 'sudo pacman -Syu', install: `sudo pacman -S ${pkg}`, remove: `sudo pacman -R ${pkg}`, search: `pacman -Ss ${pkg}`, list: 'pacman -Qu' }[action];
    case 'zypper':
      return { refresh: 'sudo zypper refresh', upgrade: 'sudo zypper update', install: `sudo zypper install ${pkg}`, remove: `sudo zypper remove ${pkg}`, search: `zypper search ${pkg}`, list: 'zypper list-updates' }[action];
    case 'brew':
      return { refresh: 'brew update', upgrade: 'brew upgrade', install: `brew install ${pkg}`, remove: `brew uninstall ${pkg}`, search: `brew search ${pkg}`, list: 'brew outdated' }[action];
    default:
      return {
        refresh: 'sudo apt update || sudo dnf makecache',
        upgrade: 'sudo apt update && sudo apt upgrade || sudo dnf upgrade',
        install: `sudo apt install ${pkg} || sudo dnf install ${pkg}`,
        remove: `sudo apt remove ${pkg} || sudo dnf remove ${pkg}`,
        search: `apt search ${pkg} || dnf search ${pkg}`,
        list: 'apt list --upgradable || dnf check-update',
      }[action];
  }
};

export const SNIPPETS: Snippet[] = [
  // System
  { id: 'sys-overview', category: 'system', title: ['Resumo do servidor (sistema, tempo ligado, carga)', 'Server summary (OS, uptime, load)'], command: 'uname -a; uptime; cat /etc/os-release | head -n 4', keywords: 'sistema versão os distro info resumo kernel summary version' },
  { id: 'sys-top', category: 'system', title: ['O que está usando CPU e memória (ao vivo)', 'What uses CPU and memory (live)'], command: 'top', keywords: 'cpu lento processador carga load processos memoria slow' },
  { id: 'sys-mem', category: 'system', title: ['Memória livre', 'Free memory'], command: 'free -h', keywords: 'memoria ram memory swap livre' },
  { id: 'sys-procs-cpu', category: 'system', title: ['10 processos que mais usam CPU', 'Top 10 processes by CPU'], command: 'ps aux --sort=-%cpu | head -n 11', keywords: 'cpu processos lento process slow' },
  { id: 'sys-procs-mem', category: 'system', title: ['10 processos que mais usam memória', 'Top 10 processes by memory'], command: 'ps aux --sort=-%mem | head -n 11', keywords: 'memoria ram processos process memory' },
  { id: 'sys-find-proc', category: 'system', title: ['Procurar um processo pelo nome', 'Find a process by name'], command: 'ps aux | grep -i <nome>', keywords: 'processo achar rodando running process find' },
  { id: 'sys-kill', category: 'system', title: ['Encerrar um processo (pelo número PID)', 'Stop a process (by PID)'], command: 'kill <pid>', keywords: 'matar encerrar parar processo kill stop' },
  { id: 'sys-time', category: 'system', title: ['Data, hora e fuso horário', 'Date, time and time zone'], command: 'timedatectl', keywords: 'data hora fuso horario timezone clock relogio' },
  { id: 'sys-cpu', category: 'system', title: ['Processador e núcleos', 'CPU and cores'], command: 'lscpu | head -n 15', keywords: 'cpu processador nucleos cores' },
  { id: 'sys-reboot-needed', category: 'system', title: ['Precisa reiniciar? (após atualizações)', 'Reboot needed? (after updates)'], command: 'ls /var/run/reboot-required 2>/dev/null && cat /var/run/reboot-required.pkgs 2>/dev/null || needs-restarting -r 2>/dev/null || echo "Nada indica reinício pendente"', keywords: 'reiniciar reboot atualizacao restart required' },

  // Disk
  { id: 'disk-free', category: 'disk', title: ['Espaço livre nos discos', 'Free disk space'], command: 'df -h', keywords: 'disco espaco livre cheio disk space full' },
  { id: 'disk-here', category: 'disk', title: ['O que ocupa mais espaço nesta pasta', 'What uses the most space here'], command: 'du -sh -- * .[!.]* 2>/dev/null | sort -rh | head -n 15', keywords: 'pasta tamanho grande ocupando espaco folder size big' },
  { id: 'disk-big-files', category: 'disk', title: ['Arquivos maiores que 100 MB', 'Files bigger than 100 MB'], command: 'sudo find / -xdev -type f -size +100M -exec ls -lh {} + 2>/dev/null | sort -k5 -rh | head -n 20', keywords: 'arquivos grandes big files encontrar espaco' },
  { id: 'disk-logs-size', category: 'disk', title: ['Tamanho dos logs', 'Size of the logs'], command: 'sudo du -sh /var/log/* 2>/dev/null | sort -rh | head -n 15', keywords: 'logs tamanho espaco var log size' },
  { id: 'disk-journal-vacuum', category: 'disk', title: ['Limpar logs antigos do systemd (manter 200 MB)', 'Trim old systemd logs (keep 200 MB)'], command: 'sudo journalctl --vacuum-size=200M', keywords: 'limpar logs espaco journal clean' },
  { id: 'disk-list', category: 'disk', title: ['Discos e partições', 'Disks and partitions'], command: 'lsblk -f', keywords: 'discos particoes volumes disks partitions' },
  { id: 'disk-inodes', category: 'disk', title: ['Disco "cheio" com espaço livre? (inodes)', 'Disk "full" but space free? (inodes)'], command: 'df -i', keywords: 'inodes cheio full' },

  // Files
  { id: 'files-list', category: 'files', title: ['Listar arquivos com detalhes (inclui ocultos)', 'List files with details (incl. hidden)'], command: 'ls -lah', keywords: 'listar arquivos ver pasta list files' },
  { id: 'files-find-name', category: 'files', title: ['Procurar arquivo pelo nome', 'Find a file by name'], command: 'find . -iname "*<nome>*" 2>/dev/null', keywords: 'procurar achar encontrar arquivo find search name' },
  { id: 'files-grep', category: 'files', title: ['Procurar um texto dentro dos arquivos', 'Search for text inside files'], command: 'grep -rni "<texto>" .', keywords: 'procurar texto conteudo dentro search text grep' },
  { id: 'files-recent', category: 'files', title: ['Arquivos alterados nas últimas 24 h', 'Files changed in the last 24 h'], command: 'find . -type f -mtime -1 -printf "%TY-%Tm-%Td %TH:%TM  %p\\n" 2>/dev/null | sort -r | head -n 30', keywords: 'recentes alterados modificados hoje recent changed' },
  { id: 'files-tail', category: 'files', title: ['Ver o final de um arquivo', 'View the end of a file'], command: 'tail -n 100 <arquivo>', keywords: 'ver final arquivo ultimo tail' },
  { id: 'files-edit', category: 'files', title: ['Editar um arquivo (nano: Ctrl+O salva, Ctrl+X sai)', 'Edit a file (nano: Ctrl+O saves, Ctrl+X quits)'], command: 'nano <arquivo>', keywords: 'editar arquivo edit file nano' },
  { id: 'files-backup', category: 'files', title: ['Fazer uma cópia de segurança de um arquivo', 'Back up a file'], command: 'cp -a <arquivo> <arquivo>.bak-$(date +%Y%m%d-%H%M)', keywords: 'backup copia seguranca copy' },
  { id: 'files-targz', category: 'files', title: ['Compactar uma pasta (.tar.gz)', 'Compress a folder (.tar.gz)'], command: 'tar -czvf <nome>.tar.gz <pasta>', keywords: 'compactar zip tar compress archive' },
  { id: 'files-untar', category: 'files', title: ['Extrair um .tar.gz', 'Extract a .tar.gz'], command: 'tar -xzvf <arquivo>.tar.gz', keywords: 'extrair descompactar unzip extract' },
  { id: 'files-perms', category: 'files', title: ['Ver permissões e dono de um arquivo', 'Show permissions and owner of a file'], command: 'ls -l <arquivo>; stat <arquivo>', keywords: 'permissao dono owner permission' },

  // Network
  { id: 'net-ip', category: 'network', title: ['Endereços IP do servidor', "Server's IP addresses"], command: 'ip -brief address', keywords: 'ip endereco rede address network' },
  { id: 'net-public-ip', category: 'network', title: ['IP público (como a internet vê o servidor)', 'Public IP (as the internet sees it)'], command: 'curl -s https://ifconfig.me; echo', keywords: 'ip publico externo public external' },
  { id: 'net-ports', category: 'network', title: ['Portas abertas e qual programa usa cada uma', 'Open ports and the program behind each'], command: 'sudo ss -tulpn', keywords: 'portas abertas escutando listening ports' },
  { id: 'net-port-check', category: 'network', title: ['Quem está usando uma porta', 'Who is using a port'], command: 'sudo ss -ltnp | grep ":<porta>"', keywords: 'porta em uso port in use' },
  { id: 'net-ping', category: 'network', title: ['Testar a conexão com outro host', 'Test the connection to a host'], command: 'ping -c 4 <host>', keywords: 'ping teste conexao internet test' },
  { id: 'net-http', category: 'network', title: ['Testar um site (código HTTP e tempo)', 'Test a website (HTTP code and time)'], command: 'curl -sS -o /dev/null -w "HTTP %{http_code} em %{time_total}s\\n" <url>', keywords: 'site http testar web curl url' },
  { id: 'net-dns', category: 'network', title: ['Consultar o DNS de um domínio', 'Look up DNS for a domain'], command: 'dig +short <dominio> || nslookup <dominio>', keywords: 'dns dominio domain' },
  { id: 'net-fw-ufw', category: 'network', title: ['Regras do firewall (Ubuntu: ufw)', 'Firewall rules (Ubuntu: ufw)'], command: 'sudo ufw status verbose', keywords: 'firewall ufw regras bloqueio' },
  { id: 'net-fw-firewalld', category: 'network', title: ['Regras do firewall (Oracle Linux/RHEL: firewalld)', 'Firewall rules (Oracle Linux/RHEL: firewalld)'], command: 'sudo firewall-cmd --list-all', keywords: 'firewall firewalld oracle oci rhel portas' },
  { id: 'net-fw-open', category: 'network', title: ['Liberar uma porta no firewalld (permanente)', 'Open a port in firewalld (permanent)'], command: 'sudo firewall-cmd --permanent --add-port=<porta>/tcp && sudo firewall-cmd --reload', keywords: 'liberar abrir porta firewall oracle oci open port' },

  // Services
  { id: 'svc-status', category: 'services', title: ['Situação de um serviço', "A service's status"], command: 'systemctl status <servico> --no-pager', keywords: 'servico status rodando service nginx apache mysql' },
  { id: 'svc-restart', category: 'services', title: ['Reiniciar um serviço', 'Restart a service'], command: 'sudo systemctl restart <servico>', keywords: 'reiniciar servico restart service' },
  { id: 'svc-failed', category: 'services', title: ['Serviços com falha', 'Failed services'], command: 'systemctl --failed --no-pager', keywords: 'falha erro servicos failed broken' },
  { id: 'svc-running', category: 'services', title: ['Serviços rodando', 'Running services'], command: 'systemctl list-units --type=service --state=running --no-pager', keywords: 'servicos rodando lista running services list' },
  { id: 'svc-enable', category: 'services', title: ['Iniciar um serviço sempre que o servidor ligar', 'Start a service at every boot'], command: 'sudo systemctl enable --now <servico>', keywords: 'iniciar boot automatico enable startup' },
  { id: 'svc-nginx-test', category: 'services', title: ['Testar a configuração do nginx', "Test nginx's configuration"], command: 'sudo nginx -t', keywords: 'nginx configuracao testar config test' },
  { id: 'svc-cron', category: 'services', title: ['Tarefas agendadas (cron) do seu usuário', "Your user's scheduled jobs (cron)"], command: 'crontab -l', keywords: 'cron agendamento agendado tarefas scheduled jobs' },

  // Logs
  { id: 'log-service', category: 'logs', title: ['Últimas mensagens de um serviço', "A service's latest messages"], command: 'journalctl -u <servico> -n 100 --no-pager', keywords: 'log servico mensagens erro service journal' },
  { id: 'log-follow', category: 'logs', title: ['Acompanhar o log de um serviço ao vivo', "Follow a service's log live"], command: 'journalctl -u <servico> -f', keywords: 'log ao vivo acompanhar follow live' },
  { id: 'log-errors', category: 'logs', title: ['Erros do sistema na última hora', 'System errors in the last hour'], command: 'journalctl -p err --since "1 hour ago" --no-pager', keywords: 'erros log sistema errors' },
  { id: 'log-syslog', category: 'logs', title: ['Final do log do sistema', 'End of the system log'], command: 'sudo tail -n 100 /var/log/syslog 2>/dev/null || sudo tail -n 100 /var/log/messages', keywords: 'syslog messages log sistema' },
  { id: 'log-auth', category: 'logs', title: ['Tentativas de login (SSH)', 'Login attempts (SSH)'], command: 'sudo tail -n 50 /var/log/auth.log 2>/dev/null || sudo tail -n 50 /var/log/secure', keywords: 'login ssh tentativas invasao seguranca auth security' },
  { id: 'log-nginx', category: 'logs', title: ['Erros do nginx', 'nginx errors'], command: 'sudo tail -n 100 /var/log/nginx/error.log', keywords: 'nginx erro log web' },
  { id: 'log-kernel', category: 'logs', title: ['Mensagens do kernel (discos, memória)', 'Kernel messages (disks, memory)'], command: 'sudo dmesg -T | tail -n 50', keywords: 'kernel dmesg hardware disco memoria oom' },

  // Packages
  { id: 'pkg-upgrade', category: 'packages', title: ['Atualizar todo o sistema', 'Update the whole system'], command: (pm) => pmCommand(pm, 'upgrade'), keywords: 'atualizar atualizacao sistema update upgrade patches' },
  { id: 'pkg-list', category: 'packages', title: ['Ver atualizações disponíveis', 'List available updates'], command: (pm) => pmCommand(pm, 'list'), keywords: 'atualizacoes disponiveis updates available' },
  { id: 'pkg-install', category: 'packages', title: ['Instalar um programa', 'Install software'], command: (pm) => pmCommand(pm, 'install'), keywords: 'instalar programa pacote install package' },
  { id: 'pkg-remove', category: 'packages', title: ['Remover um programa', 'Remove software'], command: (pm) => pmCommand(pm, 'remove'), keywords: 'remover desinstalar uninstall remove' },
  { id: 'pkg-search', category: 'packages', title: ['Procurar um programa para instalar', 'Search for software'], command: (pm) => pmCommand(pm, 'search'), keywords: 'procurar pacote search package' },

  // Users
  { id: 'usr-me', category: 'users', title: ['Quem sou eu e meus grupos', 'Who am I and my groups'], command: 'id', keywords: 'usuario quem sou grupos whoami user groups' },
  { id: 'usr-logged', category: 'users', title: ['Quem está conectado agora', 'Who is logged in now'], command: 'w', keywords: 'conectados logados usuarios online who' },
  { id: 'usr-last', category: 'users', title: ['Últimos logins', 'Recent logins'], command: 'last -n 20', keywords: 'ultimos logins acessos last' },
  { id: 'usr-add', category: 'users', title: ['Criar um usuário', 'Create a user'], command: 'sudo adduser <usuario> || sudo useradd -m <usuario>', keywords: 'criar usuario novo add user' },
  { id: 'usr-sudo', category: 'users', title: ['Dar acesso de administrador (sudo) a um usuário', 'Give a user admin rights (sudo)'], command: 'sudo usermod -aG sudo <usuario> 2>/dev/null || sudo usermod -aG wheel <usuario>', keywords: 'sudo administrador admin wheel permissao' },
  { id: 'usr-passwd', category: 'users', title: ['Trocar a senha de um usuário', "Change a user's password"], command: 'sudo passwd <usuario>', keywords: 'senha trocar password' },
  { id: 'usr-keys', category: 'users', title: ['Chaves SSH autorizadas do seu usuário', "Your user's authorized SSH keys"], command: 'cat ~/.ssh/authorized_keys', keywords: 'chaves ssh autorizadas keys authorized' },

  // Docker
  { id: 'dk-ps', category: 'docker', title: ['Contêineres rodando', 'Running containers'], command: 'docker ps', keywords: 'docker containers conteineres rodando' },
  { id: 'dk-all', category: 'docker', title: ['Todos os contêineres (inclusive parados)', 'All containers (stopped too)'], command: 'docker ps -a', keywords: 'docker containers parados' },
  { id: 'dk-logs', category: 'docker', title: ['Log de um contêiner', "A container's log"], command: 'docker logs --tail 100 -f <conteiner>', keywords: 'docker log container' },
  { id: 'dk-stats', category: 'docker', title: ['Uso de CPU e memória dos contêineres', 'Container CPU and memory use'], command: 'docker stats --no-stream', keywords: 'docker cpu memoria stats' },
  { id: 'dk-shell', category: 'docker', title: ['Abrir um terminal dentro de um contêiner', 'Open a shell inside a container'], command: 'docker exec -it <conteiner> sh', keywords: 'docker entrar shell exec bash' },
  { id: 'dk-df', category: 'docker', title: ['Espaço usado pelo Docker', 'Disk space used by Docker'], command: 'docker system df', keywords: 'docker espaco disco space' },
];

export function snippetCommand(s: Snippet, pm: PackageManager): string {
  return typeof s.command === 'function' ? s.command(pm) : s.command;
}

const PLACEHOLDERS_EN: Record<string, string> = {
  '<programa>': '<package>',
  '<servico>': '<service>',
  '<nome>': '<name>',
  '<arquivo>': '<file>',
  '<pasta>': '<folder>',
  '<texto>': '<text>',
  '<dominio>': '<domain>',
  '<porta>': '<port>',
  '<usuario>': '<user>',
  '<conteiner>': '<container>',
};

/** A ready-made command with its `<…>` placeholders in the interface language. */
export function localizeCommand(command: string, isPt: boolean): string {
  return isPt ? command : command.replace(/<[^<>\s]+>/g, (m) => PLACEHOLDERS_EN[m] ?? m);
}

/** Folds accents and case, so "espaço" matches "espaco". */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Words that say nothing about the task ("como ver o espaço em disco"). */
const STOP_WORDS = new Set(
  'a o as os um uma uns umas de do da dos das em no na nos nas para pra por com sem e ou que como meu minha meus minhas eu quero ver mostrar saber the an of in on to for my me how what show see is are and or i want'.split(' ')
);

/** Ready-made commands matching a description ("disco cheio", "restart nginx"). */
export function searchSnippets(query: string, isPt: boolean, pm: PackageManager, limit = 6): Snippet[] {
  const all = fold(query).split(/[^a-z0-9.+_-]+/).filter((w) => w.length >= 2);
  const words = all.filter((w) => !STOP_WORDS.has(w));
  if (words.length === 0) return [];
  // Most of the words must match (people describe the same task in different words).
  const needed = words.length <= 2 ? words.length : Math.ceil(words.length * 0.6);
  const scored: Array<{ s: Snippet; score: number }> = [];
  for (const s of SNIPPETS) {
    const title = fold(`${pick(s.title, isPt)} ${pick(s.title, !isPt)}`);
    const hay = `${title} ${fold(`${s.keywords} ${snippetCommand(s, pm)}`)}`;
    let matched = 0;
    let score = 0;
    for (const w of words) {
      if (!hay.includes(w)) continue;
      matched++;
      score += (w.length >= 4 ? 2 : 1) + (title.includes(w) ? 1 : 0);
    }
    if (matched >= needed) scored.push({ s, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.s);
}

/** First `<…>` placeholder in a command, to select it for typing. */
export function firstPlaceholder(command: string): [number, number] | null {
  const m = /<[^<>\s]+>/.exec(command);
  return m ? [m.index, m.index + m[0].length] : null;
}

// ---------------------------------------------------------------------------
// Error hints
// ---------------------------------------------------------------------------

export interface ErrorHint {
  text: string;
  /** A command that may fix it; `run` commands are offered to run, others to edit first. */
  fix?: { label: string; command: string; run: boolean };
}

const firstWord = (command: string) => {
  const words = shellWords(command).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  return words[0] === 'sudo' ? words[1] : words[0];
};

/** Explains a failed command in plain words, from its exit status and last output. */
export function errorHint(
  command: string | null | undefined,
  exitCode: number,
  output: string,
  pm: PackageManager,
  isPt: boolean
): ErrorHint | null {
  if (exitCode === 0 || exitCode === 130) return null;
  const out = output.slice(-3000);
  const cmd = (command || '').trim();

  const notFound = /(?:^|\n|\s)(?:bash: |zsh: |sh: )?(?:line \d+: )?([\w.+-]+): (?:command not found|comando não encontrado|not found)/i.exec(out);
  if (exitCode === 127 || notFound) {
    const name = notFound?.[1] || (cmd ? firstWord(cmd) : '');
    if (name) {
      return {
        text: isPt
          ? `O programa "${name}" não está instalado neste servidor (ou o nome está diferente).`
          : `"${name}" is not installed on this server (or the name is different).`,
        fix: { label: isPt ? 'Instalar' : 'Install', command: pmCommand(pm, 'install', name), run: false },
      };
    }
  }
  if (/could not get lock|unable to acquire the dpkg|waiting for cache lock|another app is currently holding the yum lock|is locked by another process/i.test(out)) {
    return { text: isPt ? 'Outra instalação ou atualização está em andamento. Espere ela terminar e tente de novo.' : 'Another install or update is running. Wait for it to finish and try again.' };
  }
  if (/permission denied|permissão negada|operation not permitted|must be (run as )?root|are you root|requires? (root|superuser)|you need to be root|access denied/i.test(out) || exitCode === 126) {
    if (cmd && !/^sudo\b/.test(cmd)) {
      return {
        text: isPt ? 'Faltou permissão de administrador para isso.' : 'This needs administrator rights.',
        fix: { label: isPt ? 'Repetir com sudo' : 'Retry with sudo', command: `sudo ${cmd}`, run: true },
      };
    }
    return { text: isPt ? 'Sem permissão para acessar esse arquivo ou pasta.' : 'No permission to access that file or folder.' };
  }
  if (/no space left on device/i.test(out)) {
    return {
      text: isPt ? 'O disco está cheio.' : 'The disk is full.',
      fix: { label: isPt ? 'Ver espaço livre' : 'Show free space', command: 'df -h', run: true },
    };
  }
  if (/unit [^\s]+ (could )?not (be )?found|could not be found|no such unit/i.test(out)) {
    return {
      text: isPt ? 'Esse serviço não existe com esse nome.' : 'There is no service with that name.',
      fix: { label: isPt ? 'Listar serviços' : 'List services', command: 'systemctl list-units --type=service --no-pager', run: true },
    };
  }
  if (/no such file or directory|arquivo ou diretório inexistente|não existe|cannot access/i.test(out)) {
    return {
      text: isPt ? 'Esse arquivo ou pasta não existe aqui. Confira o caminho (o comando ls mostra o que há na pasta atual).' : 'That file or folder does not exist here. Check the path (ls shows what is in the current folder).',
      fix: { label: isPt ? 'Listar a pasta' : 'List the folder', command: 'ls -la', run: true },
    };
  }
  if (/address already in use/i.test(out)) {
    return {
      text: isPt ? 'Essa porta já está sendo usada por outro programa.' : 'That port is already used by another program.',
      fix: { label: isPt ? 'Ver portas em uso' : 'Show ports in use', command: 'sudo ss -ltnp', run: true },
    };
  }
  if (/connection refused/i.test(out)) {
    return { text: isPt ? 'Nada respondeu nesse endereço e porta: o serviço pode estar parado ou um firewall bloqueia.' : 'Nothing answered at that address and port: the service may be stopped or a firewall blocks it.' };
  }
  if (/could not resolve host|name or service not known|temporary failure in name resolution|nxdomain/i.test(out)) {
    return { text: isPt ? 'Não foi possível encontrar esse endereço (DNS). Confira o nome ou a conexão do servidor com a internet.' : 'That address could not be found (DNS). Check the name or the server’s internet access.' };
  }
  if (/is a directory/i.test(out)) {
    return { text: isPt ? 'Isso é uma pasta, não um arquivo. Para pastas, muitos comandos pedem -r.' : 'That is a folder, not a file. For folders many commands need -r.' };
  }
  if (/syntax error|unexpected (token|EOF)|unterminated quoted/i.test(out)) {
    return { text: isPt ? 'Erro de digitação no comando: confira aspas, parênteses e espaços.' : 'Typo in the command: check quotes, parentheses and spaces.' };
  }
  if (/sudo: a password is required|is not in the sudoers file|não está no arquivo sudoers/i.test(out)) {
    return { text: isPt ? 'Seu usuário não pode usar sudo neste servidor. Peça acesso a um administrador.' : 'Your user may not use sudo on this server. Ask an administrator.' };
  }
  return null;
}

/** Output that waits for an answer from the user (a password, yes/no...). */
export const WAITING_FOR_INPUT =
  /(password|senha|passphrase|contraseña)[^\n]{0,80}:\s*$|\[(y\/n|Y\/n|y\/N|s\/N|S\/n|yes\/no)\]\s*\??\s*$|\((y\/n|yes\/no)[^)]*\)\s*\??\s*$|(continue|proceed|continuar)\s*\?\s*(\[[^\]]*\])?\s*$|press (enter|return|any key)|pressione (enter|qualquer tecla)/i;
