const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const cors = require('cors');
const { exec } = require('child_process');
const axios = require('axios'); 

const app = express();
const PORT = 8980;
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json());

let notifications = []; 
const notificationsFilePath = path.resolve(__dirname, './notifications.json'); // 请修改为你的指定 JSON 文件存储路径
function readNotifications() {
    if (fs.existsSync(notificationsFilePath)) {
        const data = fs.readFileSync(notificationsFilePath, 'utf8');
        if (data.trim() === '') {
            return []; 
        }
        return JSON.parse(data);
    }
    return []; 
}

function writeNotifications(notifications) {
    fs.writeFileSync(notificationsFilePath, JSON.stringify(notifications, null, 2));
}

async function sendWebhookNotification(notification) {
    const webhookUrl = 'webhook URL'; // 替换为你的 webhook URL
    if (!webhookUrl) {
        console.log('Webhook URL 未设置，跳过发送 webhook 通知。');
        return; 
    }

    try {
        console.log('Sending webhook notification:', notification); 
        await axios.post(webhookUrl, notification);
    } catch (error) {
        console.error('发送 webhook 通知时出错:', error.response ? error.response.data : error.message);
    }
}

// GET 路由，用于获取 data 文件夹中的文件列表
app.get('/data', (req, res) => {
    const dataDir = path.resolve('请修改为你的文件实际路径/data/');
    fs.readdir(dataDir, (err, files) => {
        if (err) {
            console.error('读取文件夹时出错:', err);
            return res.status(500).send('读取文件夹失败');
        }
        const yamlFiles = files.filter(file => file.endsWith('.yaml') || file.endsWith('.yml'));
        res.json(yamlFiles);
    });
});

// GET 路由，用于获取特定的 YAML 文件内容
app.get('/data/:filename', (req, res) => {
    const filename = req.params.filename;
    const dataDir = path.resolve('请修改为你的文件实际路径/data/');
    const filePath = path.join(dataDir, filename);

    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') return res.status(404).send('文件未找到');
            console.error('读取文件时出错:', err);
            return res.status(500).send('读取文件失败');
        }
        res.send(data);
    });
});

// GET 路由，用于获取更新通知
app.get('/api/notifications', (req, res) => {
    const notifications = readNotifications();
    if (notifications.length === 0) {
        return res.json({ message: '暂无更新的内容' });
    }
    res.json(notifications);
});

// POST 路由，用于添加数据到指定的 YAML 文件
app.post('/api/yaml', async (req, res) => {
    const { filename, newDataEntry } = req.body;

    if (!newDataEntry.title || !newDataEntry.url || !newDataEntry.logo || !newDataEntry.description) {
        return res.status(400).send('所有字段（标题、地址、Logo 和描述）都必须填写！');
    }

    const basePath = path.resolve('请修改为你的文件实际路径/data/');
    const absolutePath = path.join(basePath, filename);

    if (!absolutePath.startsWith(basePath)) {
        return res.status(400).send('无效的文件路径');
    }

    fs.readFile(absolutePath, 'utf8', (err, data) => {
        let yamlData = []; 

        if (err) {
            if (err.code === 'ENOENT') {
                yamlData = []; 
            } else {
                console.error('读取文件时出错:', err);
                return res.status(500).send('读取 YAML 文件失败');
            }
        } else {
            if (data.trim() === '') {
                yamlData = []; 
            } else {
                try {
                    yamlData = yaml.load(data) || [];
                } catch (parseError) {
                    console.error('解析 YAML 文件失败:', parseError);
                    return res.status(500).send('解析 YAML 文件失败');
                }
            }
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

        fs.writeFile(absolutePath, yamlString, async (err) => {
            if (err) {
                console.error('写入文件时出错:', err);
                return res.status(500).send('写入 YAML 文件失败');
            }

            // 添加更新通知
            const notification = {
                title: newDataEntry.title,
                logo: newDataEntry.logo,
                url: newDataEntry.url,
                description: newDataEntry.description
            };

            // 读取现有通知
            let notifications = readNotifications();
            notifications.unshift(notification); // 在数组前面添加新通知

            // 保持最多 20 条通知
            if (notifications.length > 20) {
                notifications = notifications.slice(0, 20);
            }

            writeNotifications(notifications);

            await sendTelegramNotification(notification, newDataEntry.term, newDataEntry.taxonomy);

            await sendWebhookNotification(notification);

            exec('cd 请修改为你的文件实际路径 && hugo', (error, stdout, stderr) => {
                if (error) {
                    console.error(`执行命令时出错: ${error.message}`);
                    return res.status(500).send('执行命令失败');
                }
                if (stderr) {
                    console.error(`命令错误输出: ${stderr}`);
                }
                console.log(`命令输出: ${stdout}`);
            });
            res.send('数据添加成功！');
        });
    });
});

// 发送 Telegram 通知的函数
async function sendTelegramNotification(notification, term, taxonomy) {
    const telegramChatId = 'Telegram 聊天 ID'; // 替换为你的 Telegram 聊天 ID
    const telegramBotToken = 'Bot Token'; // 替换为你的 Telegram Bot Token

    let message = `导航站收录更新通知！\n`;

    if (term || taxonomy) {
        if (term) {
            message += `#${term} `;
        }
        if (taxonomy) {
            message += `#${taxonomy}`;
        }
        message += `\n`; 
    }

    message += `站点名称: ${notification.title}\nLogo: ${notification.logo}\n链接: ${notification.url}\n描述: ${notification.description}`;

    try {
        await axios.post(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
            chat_id: telegramChatId,
            text: message,
            parse_mode: 'HTML'
        });
    } catch (error) {
        console.error('发送 Telegram 通知时出错:', error);
    }
}

app.get('/api/search', (req, res) => {
    const { keyword, filePath } = req.query;

    if (!filePath) {
        return res.status(400).send('未提供文件路径');
    }

    const absolutePath = path.resolve('请修改为你的文件实际路径/data/', filePath);

    fs.readFile(absolutePath, 'utf8', (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') return res.status(404).send('文件未找到');
            console.error('读取文件时出错:', err);
            return res.status(500).send('读取文件失败');
        }

        let yamlData;
        try {
            yamlData = yaml.load(data) || [];
        } catch (parseError) {
            console.error('解析 YAML 文件失败:', parseError);
            return res.status(500).send('解析 YAML 文件失败');
        }

        const results = [];
        yamlData.forEach(entry => {
            if (entry.links) {
                entry.links.forEach(link => {
                    if (link.title && typeof link.title === 'string' && link.title.includes(keyword)) {
                        results.push({
                            title: link.title,
                            url: link.url,
                            description: link.description
                        });
                    }
                });
            }
            if (entry.list) {
                entry.list.forEach(termEntry => {
                    if (termEntry.links) {
                        termEntry.links.forEach(link => {
                            if (link.title && typeof link.title === 'string' && link.title.includes(keyword)) {
                                results.push({
                                    title: link.title,
                                    url: link.url,
                                    description: link.description
                                });
                            }
                        });
                    }
                });
            }
        });

        res.json(results);
    });
});

app.delete('/api/delete', (req, res) => {
    const { filename, title } = req.body; 

    if (!filename) {
        return res.status(400).send('未提供文件路径');
    }

    const absolutePath = path.resolve('请修改为你的文件实际路径/data/', filename);

    fs.readFile(absolutePath, 'utf8', (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') {
                return res.status(404).send('文件未找到');
            }
            console.error('读取文件时出错:', err);
            return res.status(500).send('读取 YAML 文件失败');
        }

        let yamlData;
        try {
            yamlData = yaml.load(data) || [];
        } catch (parseError) {
            console.error('解析 YAML 文件失败:', parseError);
            return res.status(500).send('解析 YAML 文件失败');
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
        fs.writeFile(absolutePath, yamlString, (err) => {
            if (err) {
                console.error('写入文件时出错:', err);
                return res.status(500).send('写入 YAML 文件失败');
            }

            //命令执行
            exec('cd 请修改为你的文件实际路径 && hugo', (error, stdout, stderr) => {
                if (error) {
                    console.error(`执行命令时出错: ${error.message}`);
                    return res.status(500).send('执行命令失败');
                }
                if (stderr) {
                    console.error(`命令错误输出: ${stderr}`);
                }
                console.log(`命令输出: ${stdout}`);
            });

            // 反馈
            res.send('条目删除成功！');
        });
    });
});

app.listen(PORT, () => {
    console.log(`服务器正在运行在 http://localhost:${PORT}`);
});
