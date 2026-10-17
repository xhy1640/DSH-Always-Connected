window.__ModuleLoader__.load({
  id: 'dsh-plugin-image-chain',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect } = React;

    function FreeChainSettingsSection() {
      const [loading, setLoading] = useState(true);
      const [saving, setSaving] = useState(false);
      const [savedNotice, setSavedNotice] = useState(false);
      const [availableProviders, setAvailableProviders] = useState([]);
      const [chains, setChains] = useState([]);
      const [activeChainId, setActiveChainId] = useState(null);

      // 加载系统现有模型与当前插件设置
      const fetchSettings = async () => {
        try {
          setLoading(true);
          const res = await fetch('/api/image-chain/settings');
          const data = await res.json();
          if (data.ok) {
            if (data.currentConfig && Array.isArray(data.currentConfig.chains)) {
              setChains(data.currentConfig.chains);
              if (data.currentConfig.chains.length > 0 && !activeChainId) {
                setActiveChainId(data.currentConfig.chains[0].id);
              }
            }
            if (data.availableProviders) setAvailableProviders(data.availableProviders);
          }
        } catch (err) {
          console.error('[image-chain] 读取设置失败:', err);
        } finally {
          setLoading(false);
        }
      };

      useEffect(() => {
        fetchSettings();
      }, []);

      const handleSave = async (chainsToSave) => {
        const payload = chainsToSave || chains;
        try {
          setSaving(true);
          const res = await fetch('/api/image-chain/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chains: payload })
          });
          const data = await res.json();
          if (data.ok) {
            setSavedNotice(true);
            setTimeout(() => setSavedNotice(false), 2500);
          }
        } catch (err) {
          alert('保存失败: ' + err.message);
        } finally {
          setSaving(false);
        }
      };

      // 选中的链路
      const activeChain = chains.find(c => c.id === activeChainId) || chains[0];

      // 更新当前选中的链路
      const updateActiveChain = (updater) => {
        const updated = chains.map(c => {
          if (c.id === activeChain.id) {
            return typeof updater === 'function' ? updater(c) : { ...c, ...updater };
          }
          return c;
        });
        setChains(updated);
      };

      // 新增一条链路
      const addChain = (type) => {
        const newId = `chain-${type}-${Date.now().toString(36)}`;
        let newChain;
        if (type === 'image') {
          newChain = {
            id: newId,
            name: `新建绘画链路 ${chains.length + 1}`,
            type: 'image',
            enabled: true,
            imageConfig: {
              promptModelProvider: 'cpa',
              promptModelId: 'gemini-3.8-flash-high',
              promptSystemInstruction: 'You are an expert AI image prompt engineer. Convert the user\'s drawing request into an exquisite, highly-detailed English prompt for image generation.',
              imageModelProvider: 'cpa',
              imageModelId: 'gemini-3.1-flash-image',
              saveDirectory: 'images/generated'
            }
          };
        } else {
          newChain = {
            id: newId,
            name: `新建容灾对话链路 ${chains.length + 1}`,
            type: 'chat',
            enabled: true,
            chatConfig: {
              maxRetriesPerModel: 5,
              models: [
                { provider: 'cpa', model: 'gemini-3.8-flash-high' },
                { provider: 'cpa', model: 'claude-sonnet-4-6' }
              ]
            }
          };
        }

        const next = [...chains, newChain];
        setChains(next);
        setActiveChainId(newId);
      };

      // 删除一条链路
      const deleteChain = (idToDelete) => {
        if (chains.length <= 1) {
          alert('请至少保留一条自由链路！');
          return;
        }
        if (confirm('确定要删除这条链路吗？')) {
          const next = chains.filter(c => c.id !== idToDelete);
          setChains(next);
          setActiveChainId(next[0].id);
        }
      };

      if (loading) {
        return h('div', {
          style: { padding: '24px', color: 'var(--dsw-alias-text-secondary, #64748b)' }
        }, '正在加载自由模型链路配置...');
      }

      return h('div', {
        style: {
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '20px',
          maxWidth: '780px',
          color: 'var(--dsw-alias-text-primary, #0f172a)'
        }
      }, [
        // 头部
        h('div', { key: 'header', style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, [
          h('div', { style: { fontSize: '18px', fontWeight: '600' } }, '🔗 模型自由链路系统 (Free Model Chain)'),
          h('div', {
            style: { fontSize: '13px', color: 'var(--dsw-alias-text-secondary, #64748b)', lineHeight: '1.5' }
          }, '支持配置多条【绘画链路】与【高可用容灾对话链路】。配置保存后将自动注册为原生对话模型，在对话输入框下方的模型选择器中可直接选用！')
        ]),

        // 链路列表标签栏与新增按钮
        h('div', {
          key: 'chain-tabs',
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            flexWrap: 'wrap',
            borderBottom: '1px solid var(--dsw-alias-border-default, #e2e8f0)',
            paddingBottom: '12px'
          }
        }, [
          ...chains.map(c => h('button', {
            key: c.id,
            onClick: () => setActiveChainId(c.id),
            style: {
              padding: '6px 14px',
              borderRadius: '8px',
              border: '1px solid',
              borderColor: activeChain?.id === c.id ? 'var(--dsw-alias-brand-default, #2563eb)' : 'var(--dsw-alias-border-default, #cbd5e1)',
              backgroundColor: activeChain?.id === c.id ? 'var(--dsw-alias-brand-default, #2563eb)' : '#ffffff',
              color: activeChain?.id === c.id ? '#ffffff' : 'var(--dsw-alias-text-primary, #1e293b)',
              fontWeight: activeChain?.id === c.id ? '600' : '400',
              fontSize: '13px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              transition: 'all 0.15s ease'
            }
          }, [
            h('span', {}, c.type === 'image' ? '🎨' : '⚡️'),
            h('span', {}, c.name)
          ])),

          // 新增按钮组
          h('div', { style: { display: 'flex', gap: '6px', marginLeft: 'auto' } }, [
            h('button', {
              onClick: () => addChain('chat'),
              style: {
                padding: '5px 10px',
                borderRadius: '6px',
                border: '1px dashed #2563eb',
                backgroundColor: 'rgba(37, 99, 235, 0.05)',
                color: '#2563eb',
                fontSize: '12px',
                cursor: 'pointer'
              }
            }, '+ 对话容灾链路'),
            h('button', {
              onClick: () => addChain('image'),
              style: {
                padding: '5px 10px',
                borderRadius: '6px',
                border: '1px dashed #16a34a',
                backgroundColor: 'rgba(22, 163, 74, 0.05)',
                color: '#16a34a',
                fontSize: '12px',
                cursor: 'pointer'
              }
            }, '+ 绘画链路')
          ])
        ]),

        // 选中的链路详情配置
        activeChain && h('div', {
          key: 'active-chain-editor',
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            backgroundColor: 'var(--dsw-alias-surface-muted, #f8fafc)',
            padding: '18px',
            borderRadius: '12px',
            border: '1px solid var(--dsw-alias-border-default, #e2e8f0)'
          }
        }, [
          // 基础信息：名称与类型
          h('div', { style: { display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: '12px', alignItems: 'flex-end' } }, [
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, [
              h('label', { style: { fontSize: '12px', fontWeight: '500' } }, '链路自定义名称（在模型选择器中展示）:'),
              h('input', {
                type: 'text',
                value: activeChain.name,
                onChange: (e) => updateActiveChain({ name: e.target.value }),
                style: {
                  padding: '7px 10px',
                  borderRadius: '6px',
                  border: '1px solid var(--dsw-alias-border-default, #cbd5e1)',
                  backgroundColor: '#ffffff',
                  fontSize: '13px'
                }
              })
            ]),

            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, [
              h('label', { style: { fontSize: '12px', fontWeight: '500' } }, '链路类型:'),
              h('div', {
                style: {
                  padding: '7px 10px',
                  borderRadius: '6px',
                  backgroundColor: '#ffffff',
                  border: '1px solid var(--dsw-alias-border-default, #cbd5e1)',
                  fontSize: '13px',
                  fontWeight: '500',
                  color: activeChain.type === 'image' ? '#16a34a' : '#2563eb'
                }
              }, activeChain.type === 'image' ? '🎨 自动绘画链路' : '⚡️ 自动容灾对话链路')
            ]),

            h('button', {
              onClick: () => deleteChain(activeChain.id),
              style: {
                padding: '7px 12px',
                borderRadius: '6px',
                border: '1px solid #ef4444',
                backgroundColor: 'rgba(239, 68, 68, 0.08)',
                color: '#dc2626',
                fontSize: '12px',
                cursor: 'pointer'
              }
            }, '删除此链路')
          ]),

          // 情况 A: 绘画链路专属配置
          activeChain.type === 'image' && h('div', {
            style: { display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '6px' }
          }, [
            // 前端提示词模型卡片
            h('div', {
              style: {
                padding: '12px',
                borderRadius: '8px',
                backgroundColor: '#ffffff',
                border: '1px solid var(--dsw-alias-border-subtle, #e2e8f0)'
              }
            }, [
              h('div', { style: { fontWeight: '600', fontSize: '13px', color: '#2563eb', marginBottom: '8px' } },
                '1. 前端提示词扩写模型 A'
              ),
              h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } }, [
                h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, [
                  h('label', { style: { fontSize: '11px', color: '#64748b' } }, '提供商:'),
                  h('select', {
                    value: activeChain.imageConfig?.promptModelProvider || 'cpa',
                    onChange: (e) => {
                      const prov = e.target.value;
                      const provObj = availableProviders.find(p => p.id === prov);
                      updateActiveChain(c => ({
                        ...c,
                        imageConfig: {
                          ...(c.imageConfig || {}),
                          promptModelProvider: prov,
                          promptModelId: provObj?.models?.[0]?.id || ''
                        }
                      }));
                    },
                    style: { padding: '6px 8px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '12px' }
                  }, availableProviders.map(p => h('option', { key: p.id, value: p.id }, `${p.displayName} (${p.id})`)))
                ]),

                h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, [
                  h('label', { style: { fontSize: '11px', color: '#64748b' } }, '模型:'),
                  h('select', {
                    value: activeChain.imageConfig?.promptModelId || 'gemini-3.8-flash-high',
                    onChange: (e) => {
                      const m = e.target.value;
                      updateActiveChain(c => ({
                        ...c,
                        imageConfig: { ...(c.imageConfig || {}), promptModelId: m }
                      }));
                    },
                    style: { padding: '6px 8px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '12px' }
                  }, [
                    ...((availableProviders.find(p => p.id === (activeChain.imageConfig?.promptModelProvider || 'cpa'))?.models) || []).map(m =>
                      h('option', { key: m.id, value: m.id }, m.name || m.id)
                    )
                  ])
                ])
              ])
            ]),

            // 后端绘画模型卡片
            h('div', {
              style: {
                padding: '12px',
                borderRadius: '8px',
                backgroundColor: '#ffffff',
                border: '1px solid var(--dsw-alias-border-subtle, #e2e8f0)'
              }
            }, [
              h('div', { style: { fontWeight: '600', fontSize: '13px', color: '#16a34a', marginBottom: '8px' } },
                '2. 后端绘画模型 B (接收提示词进行渲染)'
              ),
              h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } }, [
                h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, [
                  h('label', { style: { fontSize: '11px', color: '#64748b' } }, '提供商:'),
                  h('select', {
                    value: activeChain.imageConfig?.imageModelProvider || 'cpa',
                    onChange: (e) => {
                      const prov = e.target.value;
                      const provObj = availableProviders.find(p => p.id === prov);
                      updateActiveChain(c => ({
                        ...c,
                        imageConfig: {
                          ...(c.imageConfig || {}),
                          imageModelProvider: prov,
                          imageModelId: provObj?.models?.[0]?.id || ''
                        }
                      }));
                    },
                    style: { padding: '6px 8px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '12px' }
                  }, availableProviders.map(p => h('option', { key: p.id, value: p.id }, `${p.displayName} (${p.id})`)))
                ]),

                h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, [
                  h('label', { style: { fontSize: '11px', color: '#64748b' } }, '模型:'),
                  h('select', {
                    value: activeChain.imageConfig?.imageModelId || 'gemini-3.1-flash-image',
                    onChange: (e) => {
                      const m = e.target.value;
                      updateActiveChain(c => ({
                        ...c,
                        imageConfig: { ...(c.imageConfig || {}), imageModelId: m }
                      }));
                    },
                    style: { padding: '6px 8px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '12px' }
                  }, [
                    ...((availableProviders.find(p => p.id === (activeChain.imageConfig?.imageModelProvider || 'cpa'))?.models) || []).map(m =>
                      h('option', { key: m.id, value: m.id }, m.name || m.id)
                    )
                  ])
                ])
              ])
            ]),

            // 保存路径
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, [
              h('label', { style: { fontSize: '12px', fontWeight: '500' } }, '图片相对保存目录:'),
              h('input', {
                type: 'text',
                value: activeChain.imageConfig?.saveDirectory || 'images/generated',
                onChange: (e) => {
                  const dir = e.target.value;
                  updateActiveChain(c => ({
                    ...c,
                    imageConfig: { ...(c.imageConfig || {}), saveDirectory: dir }
                  }));
                },
                style: { padding: '7px 10px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '13px' }
              })
            ])
          ]),

          // 情况 B: 对话容灾链路专属配置
          activeChain.type === 'chat' && h('div', {
            style: { display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '6px' }
          }, [
            // 重试参数
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, [
              h('label', { style: { fontSize: '12px', fontWeight: '500' } }, '单个模型连接失败重试上限:'),
              h('input', {
                type: 'number',
                min: 1,
                max: 10,
                value: activeChain.chatConfig?.maxRetriesPerModel ?? 5,
                onChange: (e) => {
                  const num = parseInt(e.target.value, 10) || 5;
                  updateActiveChain(c => ({
                    ...c,
                    chatConfig: { ...(c.chatConfig || {}), maxRetriesPerModel: num }
                  }));
                },
                style: { width: '70px', padding: '5px 8px', borderRadius: '6px', border: '1px solid #cbd5e1' }
              }),
              h('span', { style: { fontSize: '12px', color: '#64748b' } }, '次（连接重试5次失败后，将自动按序查询下一模型，保证任务不中断）')
            ]),

            // 候选模型列表（按序容灾）
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, [
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, [
                h('div', { style: { fontSize: '12px', fontWeight: '600', color: '#2563eb' } },
                  `故障转移次序列表 (当前已添加 ${(activeChain.chatConfig?.models || []).length} 个，最多限制 8 个):`
                ),
                (activeChain.chatConfig?.models || []).length < 8 && h('button', {
                  onClick: () => {
                    const currentModels = activeChain.chatConfig?.models || [];
                    if (currentModels.length >= 8) return;
                    updateActiveChain(c => ({
                      ...c,
                      chatConfig: {
                        ...(c.chatConfig || {}),
                        models: [...currentModels, { provider: 'cpa', model: 'gemini-3.8-flash-high' }]
                      }
                    }));
                  },
                  style: {
                    padding: '3px 8px',
                    borderRadius: '4px',
                    backgroundColor: '#2563eb',
                    color: '#ffffff',
                    border: 'none',
                    fontSize: '11px',
                    cursor: 'pointer'
                  }
                }, '+ 追加备用模型')
              ]),

              // 列表项
              ...((activeChain.chatConfig?.models || []).map((mNode, idx) => {
                const currentProvObj = availableProviders.find(p => p.id === mNode.provider);
                const currentProvModels = currentProvObj ? currentProvObj.models : [];

                return h('div', {
                  key: `node-${idx}`,
                  style: {
                    display: 'grid',
                    gridTemplateColumns: 'auto 1fr 1fr auto',
                    gap: '10px',
                    alignItems: 'center',
                    padding: '8px 12px',
                    borderRadius: '8px',
                    backgroundColor: '#ffffff',
                    border: '1px solid var(--dsw-alias-border-subtle, #e2e8f0)'
                  }
                }, [
                  h('span', {
                    style: {
                      fontWeight: '600',
                      fontSize: '12px',
                      padding: '2px 8px',
                      borderRadius: '10px',
                      backgroundColor: idx === 0 ? '#2563eb' : '#64748b',
                      color: '#ffffff'
                    }
                  }, `第 ${idx + 1} 次序${idx === 0 ? ' (首选)' : ' (备用)'}`),

                  // Provider
                  h('select', {
                    value: mNode.provider,
                    onChange: (e) => {
                      const newProv = e.target.value;
                      const pObj = availableProviders.find(p => p.id === newProv);
                      const firstModel = pObj?.models?.[0]?.id || '';
                      updateActiveChain(c => {
                        const nextM = [...(c.chatConfig?.models || [])];
                        nextM[idx] = { provider: newProv, model: firstModel };
                        return { ...c, chatConfig: { ...(c.chatConfig || {}), models: nextM } };
                      });
                    },
                    style: { padding: '5px 8px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '12px' }
                  }, availableProviders.map(p => h('option', { key: p.id, value: p.id }, `${p.displayName} (${p.id})`))),

                  // Model
                  h('select', {
                    value: mNode.model,
                    onChange: (e) => {
                      const newM = e.target.value;
                      updateActiveChain(c => {
                        const nextM = [...(c.chatConfig?.models || [])];
                        nextM[idx] = { ...nextM[idx], model: newM };
                        return { ...c, chatConfig: { ...(c.chatConfig || {}), models: nextM } };
                      });
                    },
                    style: { padding: '5px 8px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '12px' }
                  }, [
                    ...currentProvModels.map(m => h('option', { key: m.id, value: m.id }, m.name || m.id)),
                    !currentProvModels.some(m => m.id === mNode.model) && h('option', { key: mNode.model, value: mNode.model }, mNode.model)
                  ]),

                  // 删除该节点
                  (activeChain.chatConfig?.models || []).length > 1 && h('button', {
                    onClick: () => {
                      updateActiveChain(c => ({
                        ...c,
                        chatConfig: {
                          ...(c.chatConfig || {}),
                          models: (c.chatConfig?.models || []).filter((_, i) => i !== idx)
                        }
                      }));
                    },
                    style: {
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: '#ef4444',
                      fontSize: '14px',
                      padding: '0 6px'
                    }
                  }, '✕')
                ]);
              }))
            ])
          ])
        ]),

        // 底部保存按钮
        h('div', { key: 'save-bar', style: { display: 'flex', alignItems: 'center', gap: '12px', marginTop: '8px' } }, [
          h('button', {
            disabled: saving,
            onClick: () => handleSave(),
            style: {
              padding: '9px 24px',
              borderRadius: '8px',
              backgroundColor: saving ? '#94a3b8' : 'var(--dsw-alias-brand-default, #2563eb)',
              color: '#ffffff',
              border: 'none',
              fontWeight: '500',
              fontSize: '13px',
              cursor: saving ? 'not-allowed' : 'pointer',
              boxShadow: '0 2px 6px rgba(37, 99, 235, 0.25)'
            }
          }, saving ? '正在保存...' : '保存所有链路配置'),

          savedNotice && h('span', {
            style: { color: '#16a34a', fontSize: '13px', fontWeight: '500' }
          }, '✓ 链路配置已更新并持久化生效！模型选择器已同步')
        ])
      ]);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'image-chain',
          order: 26,
          label: () => '🔗 模型自由链路设置'
        }, FreeChainSettingsSection));
      }
    };
  }
});
