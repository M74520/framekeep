import {rm,cp} from 'node:fs/promises';
await rm('dist',{recursive:true,force:true});
await cp('public','dist',{recursive:true});
console.log('Static build ready: dist/');
