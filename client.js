window.__ModuleLoader__.load({
  id: 'dsh-always-connected',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;
    let clientCtx = null;

    const C = {
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-tertiary)',
      faint: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l2)',
      panel: 'var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1))',
      field: 'var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-2))',
      brand: 'var(--dsw-alias-state-business-primary, #2563eb)',
      ok: 'var(--dsw-alias-state-success-primary, #22c55e)',
      warn: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
      error: 'var(--dsw-alias-state-error-primary, #ef4444)'
    };

    const fieldStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '7px 10px',
      borderRadius: '8px',
      border: `1px solid ${C.border}`,
      background: C.field,
      color: C.text,
      fontSize: '13px',
      lineHeight: '20px',
      outline: 'none'
    };

    function label(text) {
      return h('div', { style: { fontSize: '12px', color: C.faint, marginBottom: '4px' } }, text);
    }

    function Section({ children, style }) {
      return h('div', {
        style: {
          background: C.panel,
          border: `1px solid ${C.border}`,
          borderRadius: '12px',
          padding: '14px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          ...style
        }
      }, children);
    }

    function Row({ children, style }) {
      return h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', ...style } }, children);
    }

    function providerSelect(providers, value, onChange) {
      return h('select', {
        value: value || '',
        onChange: event => onChange(event.target.value),
        style: fieldStyle
      }, providers.map(provider => h('option', {
        key: provider.id,
        value: provider.id
      }, `${provider.displayName || provider.id} (${provider.id})`)));
    }

    function modelSelect(providers, providerId, value, onChange) {
      const provider = providers.find(item => item.id === providerId);
      const models = provider?.models || [];
      const options = models.slice();
      if (value && !options.some(model => model.id === value)) options.unshift({ id: value, name: value });
      if (options.length === 0) {
        return h('select', { style: fieldStyle, disabled: true }, h('option', null, '该提供商没有配置模型'));
      }
      return h('select', {
        value: value || options[0].id,
        onChange: event => onChange(event.target.value),
        style: fieldStyle
      }, options.map(model => h('option', { key: model.id, value: model.id }, model.name || model.id)));
    }

    function FreeChainSettingsSection() {
      const [loading, setLoading] = useState(true);
      const [saving, setSaving] = useState(false);
      const [notice, setNotice] = useState('');
      const [error, setError] = useState('');
      const [providers, setProviders] = useState([]);
      const [chains, setChains] = useState([]);
      const [activeId, setActiveId] = useState(null);
      const [storage, setStorage] = useState('');
      const chainsRef = useRef([]);
      const timerRef = useRef(null);

      const flash = useCallback(message => {
        setNotice(message);
        setTimeout(() => setNotice(current => (current === message ? '' : current)), 2200);
      }, []);

      const persist = useCallback(async list => {
        setSaving(true);
        setError('');
        try {
          const response = await fetch('/api/image-chain/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chains: list })
          });
          const data = await response.json();
          if (!response.ok || !data.ok) throw new Error(data?.error || `HTTP ${response.status}`);
          flash('已保存');

          // 核心热更新：通知前端模型选择器立即重新拉取模型目录，无需重启！
          try {
            const modelDirs = clientCtx?.get ? clientCtx.get('modelDirectories', false) : clientCtx?.modelDirectories;
            modelDirs?.catalog?.refresh?.();
          } catch (e) {
            console.warn('[always-connected] refresh catalog error:', e);
          }
        } catch (cause) {
          setError(`保存失败：${cause.message}`);
        } finally {
          setSaving(false);
        }
      }, [flash]);

      const schedulePersist = useCallback(list => {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          persist(list);
        }, 600);
      }, [persist]);

      useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const response = await fetch('/api/image-chain/settings');
            const data = await response.json();
            if (!alive) return;
            if (!response.ok || !data.ok) throw new Error(data?.error || `HTTP ${response.status}`);
            const list = Array.isArray(data.currentConfig?.chains) ? data.currentConfig.chains : [];
            setProviders(Array.isArray(data.availableProviders) ? data.availableProviders : []);
            setChains(list);
            chainsRef.current = list;
            setActiveId(current => (current && list.some(item => item.id === current)) ? current : (list[0]?.id || null));
            setStorage(typeof data.storageFile === 'string' ? data.storageFile : '');
          } catch (cause) {
            if (alive) setError(`读取配置失败：${cause.message}`);
          } finally {
            if (alive) setLoading(false);
          }
        })();
        return () => {
          alive = false;
          if (timerRef.current) clearTimeout(timerRef.current);
        };
      }, []);

      const commit = next => {
        setChains(next);
        chainsRef.current = next;
        schedulePersist(next);
      };

      const active = chains.find(item => item.id === activeId) || chains[0] || null;

      const patchActive = updater => {
        if (!active) return;
        commit(chains.map(item => (item.id === active.id
          ? (typeof updater === 'function' ? updater(item) : { ...item, ...updater })
          : item)));
      };

      const patchImage = updater => patchActive(item => ({
        ...item,
        imageConfig: { ...(item.imageConfig || {}), ...updater(item.imageConfig || {}) }
      }));

      const addChain = type => {
        const id = `chain-${type}-${Date.now().toString(36)}`;
        const chain = type === 'image'
          ? {
              id,
              name: `绘画链路 ${chains.length + 1}`,
              type: 'image',
              enabled: true,
              imageConfig: {
                promptModelProvider: 'cpa',
                promptModelId: 'gemini-3.8-flash-high',
                imageModelProvider: 'cpa',
                imageModelId: 'gemini-3.1-flash-image',
                saveDirectory: 'images/generated'
              }
            }
          : {
              id,
              name: `容灾对话链路 ${chains.length + 1}`,
              type: 'chat',
              enabled: true,
              chatConfig: {
                maxRetriesPerModel: 5,
                models: [{ provider: 'cpa', model: 'gemini-3.8-flash-high' }]
              }
            };
        const next = [...chains, chain];
        setActiveId(id);
        commit(next);
      };

      const removeChain = id => {
        if (chains.length <= 1) {
          setError('至少保留一条链路。');
          return;
        }
        const next = chains.filter(item => item.id !== id);
        setActiveId(next[0]?.id || null);
        commit(next);
      };

      const header = h('div', null, [
        h('div', { key: 'title', style: { fontSize: '18px', fontWeight: '600', color: C.text } }, '🔗 模型自由链路'),
        h('div', { key: 'desc', style: { fontSize: '13px', color: C.dim, lineHeight: '1.6', marginTop: '4px' } },
          '配置会写入独立存储（' + (storage || '~/.dsh/storages/always-connected/chains.json') + '），插件升级不会覆盖。保存后即可在对话的模型下拉框里选择这些链路。')
      ]);

      if (loading) {
        return h('div', { style: { padding: '24px', color: C.dim, fontSize: '13px' } }, '正在加载链路配置…');
      }

      const status = h('div', {
        key: 'status',
        style: { minHeight: '18px', fontSize: '12px', color: error ? C.error : (saving ? C.warn : C.ok) }
      }, error || (saving ? '正在保存…' : notice));

      const tabs = h('div', {
        key: 'tabs',
        style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }
      }, [
        ...chains.map(chain => {
          const selected = chain.id === active?.id;
          return h('button', {
            key: chain.id,
            type: 'button',
            onClick: () => setActiveId(chain.id),
            style: {
              padding: '7px 14px',
              borderRadius: '8px',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: selected ? '600' : '400',
              border: `1px solid ${selected ? C.brand : C.border}`,
              background: selected ? C.brand : 'transparent',
              color: selected ? '#ffffff' : C.text,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px'
            }
          }, [
            h('span', { key: 'icon' }, chain.type === 'image' ? '🎨' : '⚡️'),
            h('span', { key: 'name' }, chain.name || chain.id)
          ]);
        }),
        h('div', { key: 'spacer', style: { flex: 1 } }),
        h('button', {
          key: 'add-chat',
          type: 'button',
          onClick: () => addChain('chat'),
          style: { padding: '7px 12px', borderRadius: '8px', border: `1px dashed ${C.brand}`, background: 'transparent', color: C.brand, cursor: 'pointer', fontSize: '12px' }
        }, '+ 对话容灾链路'),
        h('button', {
          key: 'add-image',
          type: 'button',
          onClick: () => addChain('image'),
          style: { padding: '7px 12px', borderRadius: '8px', border: `1px dashed ${C.ok}`, background: 'transparent', color: C.ok, cursor: 'pointer', fontSize: '12px' }
        }, '+ 绘画链路')
      ]);

      if (!active) {
        return h('div', { style: { padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' } }, [
          header,
          h('div', { style: { color: C.dim, fontSize: '13px' } }, '还没有任何链路，先创建一条吧：'),
          h('div', { style: { display: 'flex', gap: '8px' } }, [
            h('button', {
              key: 'c1', type: 'button', onClick: () => addChain('chat'),
              style: { padding: '8px 14px', borderRadius: '8px', border: 'none', background: C.brand, color: '#fff', cursor: 'pointer' }
            }, '创建对话容灾链路'),
            h('button', {
              key: 'c2', type: 'button', onClick: () => addChain('image'),
              style: { padding: '8px 14px', borderRadius: '8px', border: 'none', background: C.ok, color: '#fff', cursor: 'pointer' }
            }, '创建绘画链路')
          ]),
          status
        ]);
      }

      const basics = h(Section, { key: 'basics' }, [
        h('div', { key: 'name', style: { display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '12px' } }, [
          h('div', { key: 'n' }, [
            label('链路名称（显示在模型选择器里）'),
            h('input', {
              type: 'text',
              value: active.name || '',
              onChange: event => patchActive({ name: event.target.value }),
              style: fieldStyle
            })
          ]),
          h('div', { key: 't' }, [
            label('类型'),
            h('div', {
              style: {
                ...fieldStyle,
                color: active.type === 'image' ? C.ok : C.brand,
                fontWeight: '600'
              }
            }, active.type === 'image' ? '🎨 绘画链路' : '⚡️ 对话容灾链路')
          ])
        ])
      ]);

      const footer = h('div', {
        key: 'footer',
        style: { display: 'flex', alignItems: 'center', gap: '12px', marginTop: '4px' }
      }, [
        h('button', {
          key: 'save',
          type: 'button',
          disabled: saving,
          onClick: () => persist(chainsRef.current),
          style: {
            padding: '9px 22px',
            borderRadius: '8px',
            border: 'none',
            background: C.brand,
            color: '#fff',
            fontWeight: '600',
            fontSize: '13px',
            cursor: saving ? 'default' : 'pointer',
            opacity: saving ? 0.6 : 1
          }
        }, saving ? '保存中…' : '立即保存'),
        h('button', {
          key: 'delete',
          type: 'button',
          onClick: () => removeChain(active.id),
          style: {
            padding: '9px 14px',
            borderRadius: '8px',
            border: `1px solid ${C.error}`,
            background: 'transparent',
            color: C.error,
            cursor: 'pointer',
            fontSize: '12px'
          }
        }, '删除此链路'),
        status
      ]);

      let body;

      if (active.type === 'image') {
        const conf = active.imageConfig || {};
        body = h('div', { key: 'image', style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, [
          h(Section, { key: 'a' }, [
            h('div', { key: 'h', style: { fontSize: '13px', fontWeight: '600', color: C.brand } }, '1. 提示词模型 A'),
            h(Row, { key: 'r' }, [
              h('div', { key: 'p' }, [
                label('提供商'),
                providerSelect(providers, conf.promptModelProvider || 'cpa', value => {
                  const provider = providers.find(item => item.id === value);
                  patchImage(() => ({
                    promptModelProvider: value,
                    promptModelId: provider?.models?.[0]?.id || ''
                  }));
                })
              ]),
              h('div', { key: 'm' }, [
                label('模型'),
                modelSelect(providers, conf.promptModelProvider || 'cpa', conf.promptModelId, value => patchImage(() => ({ promptModelId: value })))
              ])
            ])
          ]),
          h(Section, { key: 'b' }, [
            h('div', { key: 'h', style: { fontSize: '13px', fontWeight: '600', color: C.ok } }, '2. 绘图模型 B'),
            h(Row, { key: 'r' }, [
              h('div', { key: 'p' }, [
                label('提供商'),
                providerSelect(providers, conf.imageModelProvider || 'cpa', value => {
                  const provider = providers.find(item => item.id === value);
                  patchImage(() => ({
                    imageModelProvider: value,
                    imageModelId: provider?.models?.[0]?.id || ''
                  }));
                })
              ]),
              h('div', { key: 'm' }, [
                label('模型'),
                modelSelect(providers, conf.imageModelProvider || 'cpa', conf.imageModelId, value => patchImage(() => ({ imageModelId: value })))
              ])
            ]),
            h('div', { key: 'dir' }, [
              label('图片保存目录（相对当前工作区）'),
              h('input', {
                type: 'text',
                value: conf.saveDirectory || 'images/generated',
                onChange: event => patchImage(() => ({ saveDirectory: event.target.value })),
                style: fieldStyle
              })
            ])
          ])
        ]);
      } else {
        const conf = active.chatConfig || {};
        const models = Array.isArray(conf.models) ? conf.models : [];
        const patchModels = next => patchActive(item => ({
          ...item,
          chatConfig: { ...(item.chatConfig || {}), models: next }
        }));

        body = h('div', { key: 'chat', style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, [
          h(Section, { key: 'retry' }, [
            h('div', { key: 'r', style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } }, [
              h('span', { key: 'l', style: { fontSize: '12px', color: C.faint } }, '单个模型重试次数'),
              h('input', {
                key: 'i',
                type: 'number',
                min: 1,
                max: 10,
                value: conf.maxRetriesPerModel ?? 5,
                onChange: event => patchActive(item => ({
                  ...item,
                  chatConfig: {
                    ...(item.chatConfig || {}),
                    maxRetriesPerModel: Math.min(10, Math.max(1, Number(event.target.value) || 5))
                  }
                })),
                style: { ...fieldStyle, width: '72px', padding: '5px 8px' }
              }),
              h('span', { key: 'h', style: { fontSize: '12px', color: C.dim } }, '失败后按次序切到下一个模型，最多 8 个')
            ])
          ]),
          h(Section, { key: 'list' }, [
            h('div', { key: 'head', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, [
              h('div', { key: 't', style: { fontSize: '13px', fontWeight: '600', color: C.brand } }, `故障转移次序（${models.length}/8）`),
              models.length < 8 ? h('button', {
                key: 'add',
                type: 'button',
                onClick: () => patchModels([...models, { provider: 'cpa', model: 'gemini-3.8-flash-high' }]),
                style: { padding: '5px 10px', borderRadius: '6px', border: 'none', background: C.brand, color: '#fff', cursor: 'pointer', fontSize: '12px' }
              }, '+ 追加模型') : null
            ]),
            ...models.map((entry, index) => h('div', {
              key: `m-${index}`,
              style: {
                display: 'grid',
                gridTemplateColumns: 'auto 1fr 1fr auto',
                gap: '8px',
                alignItems: 'center',
                padding: '8px 10px',
                borderRadius: '8px',
                border: `1px solid ${C.border}`,
                background: C.field
              }
            }, [
              h('span', {
                key: 'badge',
                style: {
                  fontSize: '11px',
                  padding: '2px 8px',
                  borderRadius: '999px',
                  background: index === 0 ? C.brand : C.border,
                  color: index === 0 ? '#fff' : C.text,
                  whiteSpace: 'nowrap'
                }
              }, `#${index + 1}${index === 0 ? ' 首选' : ''}`),
              providerSelect(providers, entry.provider, value => {
                const provider = providers.find(item => item.id === value);
                const next = models.slice();
                next[index] = { provider: value, model: provider?.models?.[0]?.id || '' };
                patchModels(next);
              }),
              modelSelect(providers, entry.provider, entry.model, value => {
                const next = models.slice();
                next[index] = { ...next[index], model: value };
                patchModels(next);
              }),
              models.length > 1 ? h('button', {
                key: 'del',
                type: 'button',
                onClick: () => patchModels(models.filter((_, i) => i !== index)),
                style: { border: 'none', background: 'transparent', color: C.error, cursor: 'pointer', fontSize: '14px' }
              }, '✕') : h('span', { key: 'blank' })
            ]))
          ])
        ]);
      }

      return h('div', {
        style: {
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          maxWidth: '760px',
          color: C.text
        }
      }, [header, tabs, basics, body, footer]);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        clientCtx = ctx;
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'image-chain',
          order: 26,
          label: () => '🔗 模型自由链路'
        }, FreeChainSettingsSection));
      }
    };
  }
});
