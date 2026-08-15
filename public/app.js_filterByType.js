window.filterByType = (type) => {
    if(!_allFiles) return;
    if (type === 'all') {
        renderFileList(_allFiles);
    } else {
        const filtered = _allFiles.filter(f => f.name.toLowerCase().endsWith('.' + type));
        renderFileList(filtered);
    }
};
