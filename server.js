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
            // 如果文件不存在，则创建新文件
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

app.get('/data', async (req, res) => {
    const folderPath = DATA_DIR; // 使用环境变量指定的文件夹路径
    try {
        const response = await axios.get(`https://api.github.com/repos/${GITHUB_REPO}/contents/${folderPath}`, {
            headers: {
                Authorization: `token ${GITHUB_TOKEN}`,
                Accept: 'application/vnd.github.v3+json'
            }
        });
        const yamlFiles = response.data
            .filter(file => file.name.endsWith('.yaml') || file.name.endsWith('.yml'))
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
        res.send('数据添加成功！');
    } catch (err) {
        console.error('处理 YAML 文件时出错:', err);
        return res.status(500).send('处理 YAML 文件失败');
    }
});

app.get('/api/search', async (req, res) => {
    const { keyword, filePath } = req.query;

    if (!filePath) {
        return res.status(400).send('未提供文件路径');
    }

    const fileUrl = getGitHubFileUrl(filePath);

    try {
        const response = await axios.get(fileUrl);
        let yamlData = yaml.load(response.data) || [];
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
    } catch (err) {
        if (err.response && err.response.status === 404) {
            return res.status(404).send('文件未找到');
        }
        console.error('读取文件时出错:', err);
        return res.status(500).send('读取文件失败');
    }
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
