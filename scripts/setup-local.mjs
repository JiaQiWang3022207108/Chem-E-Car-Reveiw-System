import {existsSync,mkdirSync,writeFileSync} from "node:fs";
import {randomBytes,pbkdf2Sync} from "node:crypto";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import path from "node:path";
const root=fileURLToPath(new URL("../",import.meta.url));
process.chdir(root);
if(!existsSync("node_modules/vinext/package.json")) {
  if(!process.env.npm_execpath) throw Error("首次运行请在 VS Code 终端执行 npm ci。");
  const install=spawnSync(process.execPath,[process.env.npm_execpath,"ci"],{stdio:"inherit"});
  if(install.status!==0) process.exit(install.status || 1);
}
// Never overwrite an existing configuration or touch the cloud credentials.
if(existsSync(".dev.vars")) {
  console.log("保留已有本地配置；本地数据与公开网站相互独立。");
  process.exit(0);
}
const password=randomBytes(18).toString("base64url");
const salt=randomBytes(18);
const hash=["pbkdf2-sha256","100000",salt.toString("base64url"),pbkdf2Sync(password,salt,100000,32,"sha256").toString("base64url")].join("$");
mkdirSync(".local",{recursive:true});
writeFileSync(".local/本地登录信息.txt","仅用于本机开发，不是公开网站的密码。\n访问密码："+password+"\n",{mode:0o600,flag:"wx"});
writeFileSync(".dev.vars",[
  "# LOCAL ONLY - do not commit or publish",
  "APP_ACCESS_PASSWORD_HASH="+JSON.stringify(hash),
  "APP_SESSION_SECRET="+JSON.stringify(randomBytes(32).toString("base64url")),
  "APP_CREDENTIAL_ENCRYPTION_KEY="+JSON.stringify(randomBytes(32).toString("base64url")),
  "",
].join("\n"),{mode:0o600,flag:"wx"});
console.log("本地配置已生成。登录信息仅保存在："+path.join(root,".local","本地登录信息.txt"));
console.log("运行 npm run dev，或在 VS Code 按 F5。不会同步、覆盖或清除线上资料。");
