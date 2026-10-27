import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { probeSandboxRunner, sandboxRunnerPath } from './sandbox-runner';

it.runIf(process.platform === 'linux')(
  'validates sealed image handoff before entering the sandbox',
  async () => {
    expect((await probeSandboxRunner()).available).toBe(true);
    const script = String.raw`
import os,fcntl,subprocess,json,tempfile,sys
helper=sys.argv[1]
required=fcntl.F_SEAL_SEAL|fcntl.F_SEAL_SHRINK|fcntl.F_SEAL_GROW|fcntl.F_SEAL_WRITE
fds=[]
def mem(data=b'valid',seals=required,size=None):
 fd=os.memfd_create('sc-handoff-test',os.MFD_ALLOW_SEALING)
 os.write(fd,data)
 if size is not None:os.ftruncate(fd,size)
 os.fchmod(fd,0o500)
 if seals:fcntl.fcntl(fd,fcntl.F_ADD_SEALS,seals)
 fds.append(fd)
 return '/proc/'+str(os.getpid())+'/fd/'+str(fd)
with tempfile.TemporaryDirectory(prefix='sc-handoff-') as root:
 def run(sources,executable='/bin/true'):
  return subprocess.run([helper,'--exec','workspace-write',root,'--protected-home',root,'--sealed-images',sources,'--',executable],capture_output=True,timeout=5).returncode
 valid=mem(open('/bin/true','rb').read())
 cases={'empty':run('[]'),'sealed':run(json.dumps([valid]),'/dev/sprint-coder-execution/image-0')}
 bad=[('unsealed',[mem(seals=0)]),('oversize',[mem(size=512*1024*1024+1)]),('duplicate',[valid,valid]),('too-many',[valid,valid,valid])]
 for bit in [fcntl.F_SEAL_SEAL,fcntl.F_SEAL_SHRINK,fcntl.F_SEAL_GROW,fcntl.F_SEAL_WRITE]:bad.append(('missing-'+str(bit),[mem(seals=required&~bit)]))
 ordinary=open(os.path.join(root,'ordinary'),'w+b');ordinary.write(b'ordinary');ordinary.flush()
 bad.append(('ordinary',['/proc/'+str(os.getpid())+'/fd/'+str(ordinary.fileno())]))
 fifo=os.path.join(root,'fifo');os.mkfifo(fifo)
 fifo_fd=os.open(fifo,os.O_RDONLY|os.O_NONBLOCK);fds.append(fifo_fd)
 bad.append(('fifo',['/proc/'+str(os.getpid())+'/fd/'+str(fifo_fd)]))
 for path in ['/proc/self/fd/3','/proc/thread-self/fd/3','/proc/0/fd/3','/proc/1/fd/-1','/proc/1/fd/9999999999999999999','/proc/1/../fd/3','/proc/1/fd/3/','/proc/1/fd/999999']:
  bad.append(('path-'+str(len(bad)),[path]))
 for label,paths in bad:cases[label]=run(json.dumps(paths))
 for label,value in [('invalid-json','['),('non-string','[1]'),('large-json',' '*1025+'[]')]:cases[label]=run(value)
 ordinary.close()
 for fd in fds:os.close(fd)
 print(json.dumps(cases))
`;
    const { stdout } = await promisify(execFile)('python3', ['-c', script, sandboxRunnerPath()], {
      timeout: 20_000,
    });
    const results: Record<string, number> = JSON.parse(stdout);
    expect(results['empty']).toBe(0);
    expect(results['sealed']).toBe(0);
    for (const [name, exit] of Object.entries(results)) {
      if (name !== 'empty' && name !== 'sealed') expect(exit, name).toBe(64);
    }
  },
  30_000,
);
