const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 8980;

const DATA_DIR = process.env.DATA_DIR || '/data/';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const NAVIGATION_URL = process.env.NAVIGATION_URL;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const STORAGE_FILE_PATH = process.env.STORAGE_FILE_PATH;

if (!GITHUB_TOKEN || !GITHUB_REPO) {
    console.error('请设置 GITHUB_TOKEN 和 GITHUB_REPO 环境变量。');
    process.exit(1);
}

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'PUT'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json());

let updateNotifications = []; // 存储更新通知

const getGitHubFileUrl = (filename) => {
    return `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${DATA_DIR}${filename}`;
};

const uploadFileToGitHub = async (filename, content) => {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filename}`;
    
    try {
        const response = await axios.get(url, {
            headers: {
                Authorization: `token ${GITHUB_TOKEN}`,
                Accept: 'application/vnd.github.v3+json'
            }
        });

        const sha = response.data.sha;

        await axios.put(url, {
            message: `Update ${filename}`,
            content: Buffer.from(content).toString('base64'),
            sha: sha
        }, {
            headers: {
                Authorization: `token ${GITHUB_TOKEN}`,
                Accept: 'application/vnd.github.v3+json'
            }
        });
    } catch (err) {
        if (err.response && err.response.status === 404) {
            await axios.put(url, {
                message: `Create ${filename}`,
                content: Buffer.from(content).toString('base64')
            }, {
                headers: {
                    Authorization: `token ${GITHUB_TOKEN}`,
                    Accept: 'application/vnd.github.v3+json'
                }
            });
        } else {
            console.error('上传文件到 GitHub 时出错:', err.response ? err.response.data : err);
            throw new Error('上传文件失败');
        }
    }
};

const sendTelegramNotification = async (message) => {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const title = "导航站收录更新通知！";

    try {
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: `<b>${title}</b>\n${message}`,
            parse_mode: 'HTML'
        });
    } catch (err) {
        console.error('发送 Telegram 通知时出错:', err);
    }
};

const sendWebhookNotification = async (notification) => {
    if (!WEBHOOK_URL) return;

    try {
        await axios.post(WEBHOOK_URL, {
            title: notification.title,
            logo: notification.logo,
            url: notification.url,
            description: notification.description,
            navigation_url: NAVIGATION_URL
        });
    } catch (err) {
        console.error('发送 Webhook 通知时出错:', err);
    }
};

const saveNotifications = () => {
    if (!STORAGE_FILE_PATH) return;

    try {
        const dataToSave = JSON.stringify(updateNotifications.slice(0, 40), null, 2);
        fs.writeFileSync(STORAGE_FILE_PATH, dataToSave);
    } catch (err) {
        console.error('保存通知数据时出错:', err);
    }
};

app.get('/data', async (req, res) => {
    const folderPath = DATA_DIR;
    try {
        const response = await axios.get(`https://api.github.com/repos/${GITHUB_REPO}/contents/${folderPath}`, {
            headers: {
                Authorization: `token ${GITHUB_TOKEN}`,
                Accept: 'application/vnd.github.v3+json'
            }
        });
        const yamlFiles = response.data
            .filter(file => typeof file.name === 'string' && (file.name.endsWith('.yaml') || file.name.endsWith('.yml')))
            .map(file => file.name);
        res.json(yamlFiles);
    } catch (err) {
        console.error('读取文件夹时出错:', err.response ? err.response.data : err);
        return res.status(500).send('读取文件夹失败');
    }
});

app.get('/data/:filename', async (req, res) => {
    const filename = req.params.filename;
    const fileUrl = getGitHubFileUrl(filename);

    try {
        const response = await axios.get(fileUrl);
        res.send(response.data);
    } catch (err) {
        console.error('读取文件时出错:', err.response ? err.response.data : err);
        if (err.response && err.response.status === 404) {
            return res.status(404).send('文件未找到');
        }
        return res.status(500).send('读取文件失败');
    }
});

app.post('/api/yaml', async (req, res) => {
    const { filename, newDataEntry } = req.body;

    if (!newDataEntry.title || !newDataEntry.url || !newDataEntry.logo || !newDataEntry.description) {
        return res.status(400).send('所有字段（标题、地址、Logo 和描述）都必须填写！');
    }

    const fileUrl = getGitHubFileUrl(filename);

    try {
        const response = await axios.get(fileUrl);
        let yamlData = [];

        if (response.status === 200) {
            yamlData = yaml.load(response.data) || [];
        }

        const taxonomyEntry = yamlData.find(entry => entry.taxonomy === newDataEntry.taxonomy);

        if (taxonomyEntry) {
            if (newDataEntry.term) {
                const termEntry = taxonomyEntry.list?.find(term => term.term === newDataEntry.term);
                if (termEntry) {
                    termEntry.links = termEntry.links || [];
                    termEntry.links.push({
                        title: newDataEntry.title,
                        logo: newDataEntry.logo,
                        url: newDataEntry.url,
                        description: newDataEntry.description
                    });
                }
            } else {
                taxonomyEntry.links = taxonomyEntry.links || [];
                taxonomyEntry.links.push({
                    title: newDataEntry.title,
                    logo: newDataEntry.logo,
                    url: newDataEntry.url,
                    description: newDataEntry.description
                });
            }
        } else {
            const newTaxonomyEntry = {
                taxonomy: newDataEntry.taxonomy,
                icon: newDataEntry.icon || '',
                links: newDataEntry.term ? [] : [{
                    title: newDataEntry.title,
                    logo: newDataEntry.logo,
                    url: newDataEntry.url,
                    description: newDataEntry.description
                }]
            };
            yamlData.push(newTaxonomyEntry);
        }

        const yamlString = '---\n' + yaml.dump(yamlData, { noRefs: true, lineWidth: -1 });

        await uploadFileToGitHub(filename, yamlString);

        const notification = {
            title: newDataEntry.title,
            logo: newDataEntry.logo,
            url: newDataEntry.url,
            description: newDataEntry.description,
        };

        updateNotifications.unshift(notification);
        if (updateNotifications.length > 40) {
            updateNotifications.pop();
        }

        saveNotifications();

        const message = `
网站名称: ${notification.title}
Logo: ${notification.logo}
链接: ${notification.url}
描述: ${notification.description}
前往导航：${NAVIGATION_URL}
`.trim();

        await sendTelegramNotification(message);
        await sendWebhookNotification(notification);

        res.send('数据添加成功！');
    } catch (err) {
        console.error('处理 YAML 文件时出错:', err);
        return res.status(500).send('处理 YAML 文件失败');
    }
});

app.get('/api/notifications', (req, res) => {
    if (updateNotifications.length === 0) {
        return res.json({ message: '暂无更新的内容' });
    }
    res.json(updateNotifications);
});

app.delete('/api/delete', async (req, res) => {
    const { filename, title } = req.body;

    if (!filename) {
        return res.status(400).send('未提供文件路径');
    }

    const fileUrl = getGitHubFileUrl(filename);

    try {
        const response = await axios.get(fileUrl);
        let yamlData = [];

        if (response.status === 200) {
            yamlData = yaml.load(response.data) || [];
        }

        let deleted = false;
        yamlData.forEach(entry => {
            if (entry.links) {
                entry.links = entry.links.filter(link => {
                    if (link.title === title) {
                        deleted = true;
                        return false; 
                    }
                    return true; 
                });
            }
            if (entry.list) {
                entry.list.forEach(termEntry => {
                    if (termEntry.links) {
                        termEntry.links = termEntry.links.filter(link => {
                            if (link.title === title) {
                                deleted = true;
                                return false; 
                            }
                            return true; 
                        });
                    }
                });
            }
        });

        if (!deleted) {
            return res.status(404).send('未找到匹配的条目');
        }

        const yamlString = '---\n' + yaml.dump(yamlData, { noRefs: true, lineWidth: -1 });
        await uploadFileToGitHub(filename, yamlString);
        res.send('条目删除成功！');
    } catch (err) {
        console.error('处理 YAML 文件时出错:', err);
        return res.status(500).send('处理 YAML 文件失败');
    }
});

app.put('/api/update', async (req, res) => {
    const { filename, title, updatedData } = req.body;

    if (!filename || !title || !updatedData) {
        return res.status(400).send('未提供文件名、标题或更新数据');
    }

    const fileUrl = getGitHubFileUrl(filename);

    try {
        const response = await axios.get(fileUrl);
        let yamlData = [];

        if (response.status === 200) {
            yamlData = yaml.load(response.data) || [];
        }

        let updated = false;
        yamlData.forEach(entry => {
            if (entry.links) {
                entry.links.forEach(link => {
                    if (link.title === title) {
                        Object.assign(link, updatedData);
                        updated = true;
                    }
                });
            }
            if (entry.list) {
                entry.list.forEach(termEntry => {
                    if (termEntry.links) {
                        termEntry.links.forEach(link => {
                            if (link.title === title) {
                                Object.assign(link, updatedData);
                                updated = true;
                            }
                        });
                    }
                });
            }
        });

        if (!updated) {
            return res.status(404).send('未找到匹配的条目');
        }

        const yamlString = '---\n' + yaml.dump(yamlData, { noRefs: true, lineWidth: -1 });
        await uploadFileToGitHub(filename, yamlString);
        res.send('条目更新成功！');
    } catch (err) {
        console.error('处理 YAML 文件时出错:', err);
        return res.status(500).send('处理 YAML 文件失败');
    }
});

app.listen(PORT, () => {
    console.log(`服务器正在运行在 http://localhost:${PORT}`);
});
