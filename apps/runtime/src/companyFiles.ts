import fs from "node:fs";
import path from "node:path";

const deniedName=/(^\.|secret|credential|password|passwd|token|private|personal|session|chat[-_]?history|聊天|个人|私密|薪资|工资|员工|人事|备份|backup)/i;
const allowedExtension=/\.(md|mdx|txt|rst|ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|swift|c|h|cpp|css|html|sql|graphql|vue|svelte|toml|yaml|yml)$/i;
const sensitiveText=/-----BEGIN[ A-Z]*PRIVATE KEY-----|(?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|password|passwd|authorization)\s*[:=]\s*\S+/i;
export class CompanyFiles {
  constructor(private readonly roots:()=>string[]){}
  listRoots(){return this.roots().map((_root,index)=>({root:index,label:`公司目录 ${index+1}`}));}
  private resolve(rootIndex:unknown,relative:unknown){
    const roots=this.roots();if(!Number.isInteger(rootIndex)||!roots[Number(rootIndex)]||typeof relative!=="string"||relative.length>1000||path.isAbsolute(relative)||relative.includes("\\")||relative.split("/").some(x=>x===".."||deniedName.test(x)))throw new Error("公司资料路径不允许。");
    const root=path.resolve(roots[Number(rootIndex)]),target=path.resolve(root,relative||".");
    if(target!==root&&!target.startsWith(root+path.sep))throw new Error("路径超出公司目录。");
    if(fs.realpathSync(root)!==root)throw new Error("公司根目录不能通过符号链接扩大范围。");
    let current=root;
    for(const part of path.relative(root,target).split(path.sep).filter(Boolean)){
      current=path.join(current,part);const stat=fs.lstatSync(current);
      if(stat.isSymbolicLink())throw new Error("公司资料不允许符号链接。");
    }
    return {root,target};
  }
  read(root:unknown,relative:unknown){
    const {target}=this.resolve(root,relative);
    if(!allowedExtension.test(target)||deniedName.test(path.basename(target)))throw new Error("文件类型不开放。");
    const before=fs.lstatSync(target);if(!before.isFile()||before.nlink!==1||before.size>128*1024)throw new Error("仅开放小型纯文本公司资料。");
    const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try{
      const opened=fs.fstatSync(fd);if(opened.ino!==before.ino||opened.dev!==before.dev||opened.size>128*1024)throw new Error("文件已变化。");
      const text=fs.readFileSync(fd,"utf8");this.resolve(root,relative);
      if(text.includes("\0"))throw new Error("不开放二进制资料。");
      return {path:String(relative),text:sensitiveText.test(text)?"[检测到凭据内容，该文件未提供给模型]":text.slice(0,16000)};
    }finally{fs.closeSync(fd);}
  }
  search(root:unknown,query:unknown){
    if(typeof query!=="string"||query.trim().length<2||query.length>120)throw new Error("请提供 2–120 字搜索词。");
    const {target}=this.resolve(root,"");const results:{path:string;excerpt:string}[]=[];
    let scanned=0;
    const visit=(directory:string,depth:number)=>{
      if(depth>8||scanned>1500||results.length>=20)return;
      for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
        if(++scanned>1500||results.length>=20)break;
        if(deniedName.test(entry.name)||entry.isSymbolicLink())continue;
        const absolute=path.join(directory,entry.name),relative=path.relative(target,absolute);
        try{
          if(entry.isDirectory())visit(absolute,depth+1);
          else if(entry.isFile()&&allowedExtension.test(entry.name)){
            const data=this.read(root,relative),at=data.text.toLowerCase().indexOf(query.toLowerCase());
            if(at>=0)results.push({path:relative,excerpt:data.text.slice(Math.max(0,at-120),at+400)});
          }
        }catch{/* Denied or changing files never enter the model input. */}
      }
    };visit(target,0);return {results,truncated:scanned>1500||results.length>=20};
  }
  retrieve(queries:string[]){
    const sources:{root:number;path:string;text:string}[]=[],seen=new Set<string>();
    for(let root=0;root<this.roots().length;root++)for(const query of queries.slice(0,3)){
      for(const hit of this.search(root,query).results){
        const key=`${root}:${hit.path}`;if(seen.has(key))continue;seen.add(key);
        const file=this.read(root,hit.path);if(file.text.startsWith("[检测到凭据"))continue;
        sources.push({root,path:hit.path,text:file.text.slice(0,3500)});if(sources.length>=6)return sources;
      }
    }
    return sources;
  }
}
