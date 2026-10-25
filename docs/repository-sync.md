# 同一主线同步两个远端

内部仓库与 GitHub 应使用同一个已脱敏的 `main`，而不是持续维护内容不同的两套提交。人员、审批数据源、凭据及运行数据只保存在本机，不提交到任意远端。本流程不改变代码许可或替代公开发布授权。

维护者确认 GitHub URL 后，在每个本地 clone 首次配置双推送远端；先检查 `git remote -v`，不要覆盖或重复添加已有 `sync`：

```bash
git remote add sync "$(git remote get-url origin)"
git remote set-url --add --push sync "$(git remote get-url origin)"
git remote set-url --add --push sync "<GITHUB_REPOSITORY_URL>"
git config remote.sync.push refs/heads/main:refs/heads/main
```

日常在共同主线完成代码提交与测试后，运行：

```bash
git -c push.followTags=false push sync main
```

两站顺序推送，并非跨站点原子事务；某站失败时处理后重试，同一提交不会重复生成。两个远端的 `refs/heads/main` 都等于本机 `main` 才算同步完成。远端地址仅保存在本机 Git 配置中。

禁止对公开远端使用 `--mirror`、`--all` 或 `--tags`，避免将仅限内部的原历史、旧标签和未脱敏分支公开。旧 clone/工作树不能把旧历史合回共同主线。协作者应保留个人改动后重新克隆或人工迁移补丁；外部贡献在共同历史上正常评审和合入后再同步两站。
