import { useQuery } from '@tanstack/react-query';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  projectId: string;
}

export default function WuxiaView({ projectId }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ['novel-file', projectId, 'wuxia'],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/files/.novel/wuxia/system.md`);
      if (!res.ok) return null;
      return res.text();
    },
  });

  if (isLoading) return <div>加载中...</div>;
  if (!data) return <div>尚未创建武侠设定。在聊天面板中输入 /wuxia 开始。</div>;

  return (
    <div>
      <h3>武侠</h3>
      <Markdown remarkPlugins={[remarkGfm]}>{data}</Markdown>
    </div>
  );
}
